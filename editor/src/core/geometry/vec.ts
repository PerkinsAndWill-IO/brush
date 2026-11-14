import type { Point, Rect } from '../types'

export const EPS = 1e-9

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k })
export const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y
export const cross = (a: Point, b: Point): number => a.x * b.y - a.y * b.x
export const len = (a: Point): number => Math.hypot(a.x, a.y)
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)
export const dist2 = (a: Point, b: Point): number => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}
export const normalize = (a: Point): Point => {
  const l = len(a)
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}
/** Direction angle of a vector (radians, atan2 convention, y down). */
export const angle = (a: Point): number => Math.atan2(a.y, a.x)
export const rotate = (a: Point, rad: number, origin: Point = { x: 0, y: 0 }): Point => {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const dx = a.x - origin.x
  const dy = a.y - origin.y
  return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c }
}
export const lerp = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
})
export const midpoint = (a: Point, b: Point): Point => lerp(a, b, 0.5)

export interface ClosestResult {
  point: Point
  /** Parameter along the segment, 0..1. */
  t: number
  distance: number
}

export function closestPointOnSegment(p: Point, a: Point, b: Point): ClosestResult {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 < EPS ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const point = { x: a.x + dx * t, y: a.y + dy * t }
  return { point, t, distance: Math.hypot(p.x - point.x, p.y - point.y) }
}

export function segmentDistance(p: Point, a: Point, b: Point): number {
  return closestPointOnSegment(p, a, b).distance
}

/** Squared distance from (px,py) to segment (no allocation). */
export function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 < EPS ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + dx * t - px
  const cy = ay + dy * t - py
  return cx * cx + cy * cy
}

export interface PolylineClosest extends ClosestResult {
  /** Index of the segment (from points[segIndex] to points[segIndex+1]). */
  segIndex: number
}

export function closestPointOnPolyline(p: Point, pts: readonly Point[], closed = false): PolylineClosest {
  if (pts.length === 0) return { point: { ...p }, t: 0, distance: Infinity, segIndex: -1 }
  if (pts.length === 1) return { point: { ...pts[0] }, t: 0, distance: dist(p, pts[0]), segIndex: 0 }
  let best: PolylineClosest = { point: pts[0], t: 0, distance: Infinity, segIndex: 0 }
  const n = closed ? pts.length : pts.length - 1
  for (let i = 0; i < n; i++) {
    const r = closestPointOnSegment(p, pts[i], pts[(i + 1) % pts.length])
    if (r.distance < best.distance) best = { ...r, segIndex: i }
  }
  return best
}

export interface SegmentIntersection {
  point: Point
  /** Parameter along ab. */
  t: number
  /** Parameter along cd. */
  u: number
}

/** Intersection of segments ab and cd (touching counts). Parallel/collinear -> null. */
export function segmentIntersection(a: Point, b: Point, c: Point, d: Point): SegmentIntersection | null {
  const r = sub(b, a)
  const s = sub(d, c)
  const denom = cross(r, s)
  if (Math.abs(denom) < EPS) return null
  const ca = sub(c, a)
  const t = cross(ca, s) / denom
  const u = cross(ca, r) / denom
  const e = 1e-9
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null
  return { point: { x: a.x + r.x * t, y: a.y + r.y * t }, t, u }
}

/** Infinite-line intersection. Parallel -> null. */
export function lineIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = sub(b, a)
  const s = sub(d, c)
  const denom = cross(r, s)
  if (Math.abs(denom) < EPS) return null
  const t = cross(sub(c, a), s) / denom
  return { x: a.x + r.x * t, y: a.y + r.y * t }
}

export function polylineLength(pts: readonly Point[], closed = false): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  if (closed && pts.length > 2) l += dist(pts[pts.length - 1], pts[0])
  return l
}

export function bbox(pts: readonly Point[]): Rect {
  if (pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export const rectContains = (r: Rect, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

export const inflateRect = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m })

/** Does segment ab touch the rect? */
export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  if (rectContains(r, a) || rectContains(r, b)) return true
  const tl = { x: r.x, y: r.y }
  const tr = { x: r.x + r.w, y: r.y }
  const br = { x: r.x + r.w, y: r.y + r.h }
  const bl = { x: r.x, y: r.y + r.h }
  return (
    segmentIntersection(a, b, tl, tr) !== null ||
    segmentIntersection(a, b, tr, br) !== null ||
    segmentIntersection(a, b, br, bl) !== null ||
    segmentIntersection(a, b, bl, tl) !== null
  )
}

/** Signed shoelace area. */
export function polygonSignedArea(pts: readonly Point[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}
export const polygonArea = (pts: readonly Point[]): number => Math.abs(polygonSignedArea(pts))

export function polygonContains(pts: readonly Point[], p: Point): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Smallest absolute difference between two angles modulo `period` (default pi: lines, not rays). Range 0..period/2. */
export function angleDiffMod(a: number, b: number, period = Math.PI): number {
  let d = (a - b) % period
  if (d < 0) d += period
  return Math.min(d, period - d)
}

/** Signed difference a-b in (-pi, pi]. */
export function angleDiffSigned(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d <= -Math.PI) d += 2 * Math.PI
  return d
}

/** Convex hull (monotone chain). */
export function convexHull(pts: readonly Point[]): Point[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  if (p.length < 3) return p
  const build = (seq: Point[]): Point[] => {
    const h: Point[] = []
    for (const q of seq) {
      while (h.length >= 2 && cross(sub(h[h.length - 1], h[h.length - 2]), sub(q, h[h.length - 2])) <= 0) h.pop()
      h.push(q)
    }
    h.pop()
    return h
  }
  return build(p).concat(build(p.slice().reverse()))
}
