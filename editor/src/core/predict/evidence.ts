import type { ContextItem, Point, PrimitiveFit, PrimitiveKind, Rect, SheetContext, Stroke, StrokeFeatures } from '../types'
import {
  angle,
  angleDiffMod,
  bbox,
  dist,
  inflateRect,
  polygonContains,
  rectsIntersect,
  resampleByCount,
  segmentIntersection,
  snapPoint,
  sub,
  type SnapResult,
} from '../geometry'
import { extractFeatures } from '../stroke'
import { roomAt, type RoomResult } from '../context'
import { prepareContext, ptPerMetre, type PreparedContext } from './context-cache'

/** Scale assumed when the sheet has none (most plans in the fixtures are 1:100). */
export const ASSUMED_SCALE = 100

/** Distance tolerances in sheet points. */
export const TOL = {
  /** A sample this close to a wall/grid line counts as "along" it. */
  along: 6,
  /** Endpoint proximity to walls/grids. */
  endpoint: 14,
  /** Label proximity for underline/circle-around-label markup. */
  label: 12,
}

export interface Crossing {
  itemId: string
  point: Point
  /** Wall segment direction, radians. */
  wallAngle: number
  /** Angle between the stroke and the wall, 0..pi/2. */
  incidence: number
  /** Position of the crossing along the stroke, 0 = start, 1 = end. */
  u: number
}

/** Everything the rules look at for one snapshot of a stroke. */
export interface Evidence {
  stroke: Stroke
  f: StrokeFeatures
  fit: Partial<Record<PrimitiveKind, PrimitiveFit>>
  best?: PrimitiveFit
  samples: Point[]
  /** chord / length, 1 = perfectly straight. */
  straightness: number
  ptPerM: number
  scaleKnown: boolean
  lengthM: number
  bboxM: { w: number; h: number }
  /** Context present (not a scanned / shape-only sheet). */
  hasContext: boolean
  pc: PreparedContext
  /** Fraction of samples lying on a wall (resp. grid) line, and the dominant item. */
  alongWall: number
  alongGrid: number
  alongWallId?: string
  /** Angle between the stroke's line fit and the nearest wall/grid direction (rad, mod pi), when one is near. */
  alignDiff?: number
  start: SnapResult
  end: SnapResult
  /** Endpoint snaps restricted to walls (door swing arcs hang off walls, not grids). */
  startWall: SnapResult
  endWall: SnapResult
  crossings: Crossing[]
  room: RoomResult
  /** Labels the stroke encloses or runs right under/through. */
  labelsNear: ContextItem[]
  labelInside?: ContextItem
  /** Width of the enclosed label / width of the stroke's box (a ring hugging a label is markup). */
  labelCover: number
  /** Fixtures substantially covered by the stroke's extent. */
  fixturesOver: { item: ContextItem; overlap: number }[]
  /** Walls with a segment inside the stroke's extent (scribble over a wall). */
  wallsOver: { item: ContextItem; near: number }[]
}

const isWall = (i: ContextItem) => i.kind === 'wall'

function rectOverlapFrac(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  if (x1 <= x0 || y1 <= y0) return 0
  const area = Math.max(1e-6, a.w * a.h)
  return ((x1 - x0) * (y1 - y0)) / area
}

const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** Compute features and context relations for the current stroke snapshot. */
export function gatherEvidence(stroke: Stroke, ctx: SheetContext, opts: { snapRadiusPt?: number } = {}): Evidence {
  const pc = prepareContext(ctx)
  const scaleKnown = pc.ptPerM !== undefined
  const ptPerM = pc.ptPerM ?? ptPerMetre(ASSUMED_SCALE)
  const f = extractFeatures(stroke, { scale: ctx.scale })
  const fit: Evidence['fit'] = {}
  for (const x of f.fits) if (!fit[x.kind]) fit[x.kind] = x
  const pts: Point[] = stroke.points.map((p) => ({ x: p.x, y: p.y }))
  const samples = pts.length >= 2 && f.lengthPt > 1e-6 ? resampleByCount(pts, 32) : pts.slice(0, 1)
  const first = pts[0] ?? { x: 0, y: 0 }
  const last = pts[pts.length - 1] ?? first
  const straightness = f.lengthPt > 1e-6 ? dist(first, last) / f.lengthPt : 1
  const none: SnapResult = { point: first, kind: 'none', itemIds: [], distance: 0 }
  const ev: Evidence = {
    stroke,
    f,
    fit,
    best: f.fits[0],
    samples,
    straightness,
    ptPerM,
    scaleKnown,
    lengthM: f.lengthPt / ptPerM,
    bboxM: { w: f.bbox.w / ptPerM, h: f.bbox.h / ptPerM },
    hasContext: !pc.shapeOnly,
    pc,
    alongWall: 0,
    alongGrid: 0,
    start: none,
    end: { ...none, point: last },
    startWall: none,
    endWall: { ...none, point: last },
    crossings: [],
    room: {},
    labelsNear: [],
    labelCover: 0,
    fixturesOver: [],
    wallsOver: [],
  }
  if (pc.shapeOnly || pts.length === 0) return ev

  // along walls / grids
  const counts = new Map<string, number>()
  let nWall = 0
  let nGrid = 0
  for (const s of samples) {
    const hits = pc.lines.itemsNear(s, TOL.along)
    if (!hits.length) continue
    const w = hits.find((h) => h.item.kind === 'wall')
    if (w) {
      nWall++
      counts.set(w.item.id, (counts.get(w.item.id) ?? 0) + 1)
    }
    if (hits.some((h) => h.item.kind === 'grid')) nGrid++
  }
  ev.alongWall = nWall / samples.length
  ev.alongGrid = nGrid / samples.length
  let bestN = 0
  for (const [id, n] of counts) if (n > bestN || (n === bestN && ev.alongWallId !== undefined && id < ev.alongWallId)) {
    bestN = n
    ev.alongWallId = id
  }

  // alignment with the nearest wall/grid direction (line fit direction)
  const line = fit.line
  if (line && line.path.points.length >= 2) {
    const a = line.path.points[0]
    const b = line.path.points[line.path.points.length - 1]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const near = pc.lines.itemsNear(mid, Math.max(20, f.lengthPt / 2))
    if (near.length) {
      const h = near[0]
      const gp = h.item.geometry.points
      if (gp.length >= 2) {
        const wa = angle(sub(gp[(h.segIndex + 1) % gp.length], gp[h.segIndex]))
        ev.alignDiff = angleDiffMod(angle(sub(b, a)), wa)
      }
    }
  }

  // endpoints
  const radius = Math.max(opts.snapRadiusPt ?? 8, TOL.endpoint)
  ev.start = snapPoint(first, pc.lines, { radius })
  ev.end = snapPoint(last, pc.lines, { radius })
  ev.startWall = snapPoint(first, pc.lines, { radius, kinds: ['wall'] })
  ev.endWall = snapPoint(last, pc.lines, { radius, kinds: ['wall'] })

  // crossings with walls
  const crossed = new Map<string, Crossing>()
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const r = inflateRect(bbox([a, b]), 1)
    for (const w of pc.lines.itemsInRect(r, isWall)) {
      if (crossed.has(w.id)) continue
      const gp = w.geometry.points
      const n = w.geometry.closed ? gp.length : gp.length - 1
      for (let k = 0; k < n; k++) {
        const c = gp[k]
        const d = gp[(k + 1) % gp.length]
        const x = segmentIntersection(a, b, c, d)
        if (!x) continue
        const wallAngle = angle(sub(d, c))
        crossed.set(w.id, {
          itemId: w.id,
          point: x.point,
          wallAngle,
          incidence: angleDiffMod(angle(sub(b, a)), wallAngle),
          u: (i - 1 + x.t) / (samples.length - 1),
        })
        break
      }
    }
  }
  ev.crossings = [...crossed.values()]

  // room
  ev.room = roomAt(ctx, center(f.bbox))

  // labels
  const sb = f.bbox
  const near = inflateRect(sb, TOL.label)
  for (const { item, box } of pc.labels) {
    if (!rectsIntersect(near, box)) continue
    ev.labelsNear.push(item)
    if (!ev.labelInside && f.closureRatio < 0.35 && samples.length >= 3 && polygonContains(samples, center(box))) {
      ev.labelInside = item
      ev.labelCover = box.w / Math.max(1e-6, sb.w)
    }
  }

  // fixtures and walls under the stroke (delete)
  for (const { item, box } of pc.fixtures) {
    const ov = rectOverlapFrac(box, sb)
    if (ov > 0.25) ev.fixturesOver.push({ item, overlap: ov })
  }
  ev.fixturesOver.sort((a, b) => b.overlap - a.overlap || (a.item.id < b.item.id ? -1 : 1))
  for (const w of pc.lines.itemsInRect(sb, isWall)) {
    let n = 0
    for (const s of samples) if (pc.lines.itemsNear(s, Math.max(TOL.along, 10), (i) => i.id === w.id).length) n++
    ev.wallsOver.push({ item: w, near: n / samples.length })
  }
  ev.wallsOver.sort((a, b) => b.near - a.near || (a.item.id < b.item.id ? -1 : 1))
  return ev
}
