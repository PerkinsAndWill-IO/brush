import type { ContextItem, ContextItemKind, Point } from '../types'
import { PointGrid, SpatialIndex } from './spatial'
import { angle, angleDiffMod, angleDiffSigned, segmentIntersection, sub } from './vec'

export type SnapKind = 'endpoint' | 'intersection' | 'on-wall' | 'on-grid' | 'none'

export interface SnapResult {
  point: Point
  kind: SnapKind
  /** Context item ids that produced the target. */
  itemIds: string[]
  /** Distance from the query point to the snapped point. */
  distance: number
}

export interface SnapOptions {
  radius?: number
  /** Item kinds that can be snapped to. Default wall + grid. */
  kinds?: ContextItemKind[]
}

interface Target {
  ids: string[]
  conf: number
  kind: 'endpoint' | 'intersection'
  lineKind: ContextItemKind
}

interface SnapData {
  points: PointGrid<Target>
  kinds: Set<ContextItemKind>
}

const cache = new WeakMap<SpatialIndex, Map<string, SnapData>>()

/** Priority multipliers on distance: lower = preferred. */
const FACTOR = { intersection: 0.3, endpoint: 0.4, line: 1 }

function build(index: SpatialIndex, kinds: Set<ContextItemKind>): SnapData {
  const cell = Math.max(8, index.cellSize / 2)
  const points = new PointGrid<Target>(cell)
  const eligible = (it: ContextItem): boolean => kinds.has(it.kind)
  for (const it of index.items) {
    if (!eligible(it)) continue
    for (const p of it.geometry.points) points.insert(p, { ids: [it.id], conf: it.confidence, kind: 'endpoint', lineKind: it.kind })
  }
  const seen = new Map<string, Target>()
  index.forEachCandidatePair((i, j) => {
    const A = index.segment(i)
    const B = index.segment(j)
    if (A.itemIndex === B.itemIndex) return
    const ia = index.items[A.itemIndex]
    const ib = index.items[B.itemIndex]
    if (!eligible(ia) || !eligible(ib)) return
    const x = segmentIntersection(A.a, A.b, B.a, B.b)
    if (!x) return
    const key = `${Math.round(x.point.x * 20)},${Math.round(x.point.y * 20)}`
    const existing = seen.get(key)
    if (existing) {
      for (const id of [ia.id, ib.id]) if (!existing.ids.includes(id)) existing.ids.push(id)
      existing.conf = Math.min(existing.conf, ia.confidence, ib.confidence)
      return
    }
    const t: Target = { ids: [ia.id, ib.id], conf: Math.min(ia.confidence, ib.confidence), kind: 'intersection', lineKind: ia.kind }
    seen.set(key, t)
    points.insert(x.point, t)
  })
  return { points, kinds }
}

function dataFor(index: SpatialIndex, kinds: ContextItemKind[]): SnapData {
  let m = cache.get(index)
  if (!m) {
    m = new Map()
    cache.set(index, m)
  }
  const key = kinds.slice().sort().join(',')
  let d = m.get(key)
  if (!d) {
    d = build(index, new Set(kinds))
    m.set(key, d)
  }
  return d
}

const weight = (conf: number): number => 0.5 + 0.5 * Math.max(0, Math.min(1, conf))

/**
 * Best snap target within `radius` (default 8 pt). Preference: intersections,
 * then endpoints/vertices, then the nearest point on a wall centerline or grid
 * line; a lower-confidence item has to be proportionally closer to win.
 * Intersection and endpoint tables are precomputed on first use per index.
 */
export function snapPoint(point: Point, index: SpatialIndex, opts: SnapOptions = {}): SnapResult {
  const radius = opts.radius ?? 8
  const kinds = opts.kinds ?? ['wall', 'grid']
  const data = dataFor(index, kinds)
  let best: SnapResult | null = null
  let bestCost = Infinity
  for (const c of data.points.query(point, radius)) {
    const f = c.v.kind === 'intersection' ? FACTOR.intersection : FACTOR.endpoint
    // endpoints sitting exactly on an intersection are covered by the intersection entry
    const cost = (c.distance * f) / weight(c.v.conf)
    if (cost < bestCost) {
      bestCost = cost
      best = { point: { ...c.p }, kind: c.v.kind, itemIds: c.v.ids.slice(), distance: c.distance }
    }
  }
  // Point targets (intersections, endpoints) strictly win over the line fallback:
  // a stroke end a few points short of a corner along a wall must land ON the corner.
  if (best) return best
  for (const h of index.itemsNear(point, radius, (it) => kinds.includes(it.kind))) {
    const cost = (h.distance * FACTOR.line) / weight(h.item.confidence)
    if (cost < bestCost) {
      bestCost = cost
      best = {
        point: h.point,
        kind: h.item.kind === 'grid' ? 'on-grid' : 'on-wall',
        itemIds: [h.item.id],
        distance: h.distance,
      }
    }
  }
  return best ?? { point: { ...point }, kind: 'none', itemIds: [], distance: 0 }
}

// ───────────────────────────── angle snapping ─────────────────────────────

export interface AngleSnapOptions {
  /** Tolerance in degrees. Default 6. */
  toleranceDeg?: number
  /** Axis steps in degrees, default every 45. */
  stepDeg?: number
  /** Look for wall/grid directions within this radius of `from`. Default 40 pt. */
  wallRadius?: number
  /** Directions (radians, mod pi) to snap to in addition, e.g. precomputed. */
  extraDirections?: number[]
}

export interface AngleSnapResult {
  point: Point
  angleRad: number
  snappedTo: 'wall' | 'axis' | 'none'
  /** Id of the wall that supplied the direction when snappedTo === 'wall'. */
  itemId?: string
}

/** Direction (radians, y down) of the segment of the nearest wall/grid near `p`, if any. */
export function nearestWallDirection(
  p: Point,
  index: SpatialIndex,
  radius: number,
  kinds: ContextItemKind[] = ['wall', 'grid'],
): { angleRad: number; itemId: string } | null {
  const hits = index.itemsNear(p, radius, (it) => kinds.includes(it.kind))
  if (!hits.length) return null
  const h = hits[0]
  const pts = h.item.geometry.points
  if (pts.length < 2) return null
  const a = pts[h.segIndex]
  const b = pts[(h.segIndex + 1) % pts.length]
  return { angleRad: angle(sub(b, a)), itemId: h.item.id }
}

/**
 * Snap the direction from `from` to `to` to the nearest 0/45/90 degree axis, or
 * to the direction of a nearby wall (preferred when both qualify), keeping the
 * length. Returns the input point when nothing is within tolerance.
 */
export function snapAngle(from: Point, to: Point, index?: SpatialIndex, opts: AngleSnapOptions = {}): AngleSnapResult {
  const tol = ((opts.toleranceDeg ?? 6) * Math.PI) / 180
  const step = ((opts.stepDeg ?? 45) * Math.PI) / 180
  const v = sub(to, from)
  const L = Math.hypot(v.x, v.y)
  const ang = angle(v)
  if (L < 1e-9) return { point: { ...to }, angleRad: ang, snappedTo: 'none' }
  const emit = (target: number, snappedTo: 'wall' | 'axis', itemId?: string): AngleSnapResult => {
    // keep the same heading side as the original vector
    const flip = Math.abs(angleDiffSigned(ang, target)) > Math.PI / 2 ? target + Math.PI : target
    return {
      point: { x: from.x + Math.cos(flip) * L, y: from.y + Math.sin(flip) * L },
      angleRad: flip,
      snappedTo,
      itemId,
    }
  }
  let bestWall: { a: number; id?: string; d: number } | null = null
  if (index) {
    const w = nearestWallDirection(from, index, opts.wallRadius ?? 40)
    if (w) {
      const d = angleDiffMod(ang, w.angleRad)
      if (d <= tol) bestWall = { a: w.angleRad, id: w.itemId, d }
    }
  }
  for (const e of opts.extraDirections ?? []) {
    const d = angleDiffMod(ang, e)
    if (d <= tol && (!bestWall || d < bestWall.d)) bestWall = { a: e, d }
  }
  if (bestWall) return emit(bestWall.a, 'wall', bestWall.id)
  const k = Math.round(ang / step)
  const axis = k * step
  if (Math.abs(angleDiffSigned(ang, axis)) <= tol) return emit(axis, 'axis')
  return { point: { ...to }, angleRad: ang, snappedTo: 'none' }
}

