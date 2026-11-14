/**
 * Ink geometry. PURE: no DOM. Turns stored stroke points (sheet pts) into SVG
 * path data, and hit-tests eraser paths against strokes.
 *
 * Stored points are the raw pen samples (good training data, M1-12);
 * smoothing is applied only when rendering (M1-06).
 */
import { smoothPolyline } from '@core/geometry'
import type { Point, Rect, Stroke, StrokePoint } from '@core/types'

export interface InkRender {
  /** 'stroke': `d` is a centerline drawn with stroke-width = width. 'fill': `d` is a closed outline (pressure). */
  mode: 'stroke' | 'fill'
  d: string
  width: number
}

const f = (n: number) => (Math.round(n * 100) / 100).toString()

/** Pressure → width factor. p = 0.5 (the default a mouse reports) gives exactly `size`. */
export const pressureWidth = (size: number, p: number): number => size * (0.3 + 1.4 * Math.max(0, Math.min(1, p)))

export function hasPressure(points: readonly StrokePoint[]): boolean {
  let lo = Infinity
  let hi = -Infinity
  for (const q of points) {
    if (q.p === undefined) return false
    lo = Math.min(lo, q.p)
    hi = Math.max(hi, q.p)
  }
  return points.length > 0 && hi - lo > 1e-3
}

/** SVG render data for a stroke. Constant width → stroked centerline; varying pressure → filled outline. */
export function inkRender(points: readonly StrokePoint[], size: number, smoothing: number): InkRender {
  if (points.length === 0) return { mode: 'stroke', d: '', width: size }
  const sm = smoothing > 0 && points.length > 2 ? smoothPolyline(points, smoothing) : points
  if (!hasPressure(points)) {
    let d = `M${f(sm[0].x)} ${f(sm[0].y)}`
    if (sm.length === 1) d += `L${f(sm[0].x + 0.01)} ${f(sm[0].y)}`
    for (let i = 1; i < sm.length; i++) d += `L${f(sm[i].x)} ${f(sm[i].y)}`
    return { mode: 'stroke', d, width: size }
  }
  const widths = points.map((q) => pressureWidth(size, q.p ?? 0.5))
  return { mode: 'fill', d: outlinePath(sm, widths), width: size }
}

/** Closed outline of a variable-width polyline with round caps (SVG arcs). */
export function outlinePath(pts: readonly Point[], widths: readonly number[]): string {
  const n = pts.length
  const r = (i: number) => Math.max(0.05, widths[Math.min(i, widths.length - 1)] / 2)
  if (n === 1 || (n === 2 && pts[0].x === pts[1].x && pts[0].y === pts[1].y)) {
    const { x, y } = pts[0]
    const rr = r(0)
    return `M${f(x - rr)} ${f(y)}A${f(rr)} ${f(rr)} 0 1 0 ${f(x + rr)} ${f(y)}A${f(rr)} ${f(rr)} 0 1 0 ${f(x - rr)} ${f(y)}Z`
  }
  const left: Point[] = []
  const right: Point[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(n - 1, i + 1)]
    let dx = b.x - a.x
    let dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    dx /= len
    dy /= len
    const rr = r(i)
    left.push({ x: pts[i].x - dy * rr, y: pts[i].y + dx * rr })
    right.push({ x: pts[i].x + dy * rr, y: pts[i].y - dx * rr })
  }
  let d = `M${f(left[0].x)} ${f(left[0].y)}`
  for (let i = 1; i < n; i++) d += `L${f(left[i].x)} ${f(left[i].y)}`
  const re = r(n - 1)
  d += `A${f(re)} ${f(re)} 0 0 0 ${f(right[n - 1].x)} ${f(right[n - 1].y)}`
  for (let i = n - 2; i >= 0; i--) d += `L${f(right[i].x)} ${f(right[i].y)}`
  const rs = r(0)
  d += `A${f(rs)} ${f(rs)} 0 0 0 ${f(left[0].x)} ${f(left[0].y)}Z`
  return d
}

// ───────────── hit testing (eraser, M1-08) ─────────────

export function pointsBBox(points: readonly Point[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    if (p.x < x0) x0 = p.x
    if (p.y < y0) y0 = p.y
    if (p.x > x1) x1 = p.x
    if (p.y > y1) y1 = p.y
  }
  return points.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 }
}

function distPointSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function segsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = o(c, d, a)
  const d2 = o(c, d, b)
  const d3 = o(a, b, c)
  const d4 = o(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Distance between segments ab and cd. */
export function segDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (segsIntersect(a, b, c, d)) return 0
  return Math.min(distPointSeg(a, c, d), distPointSeg(b, c, d), distPointSeg(c, a, b), distPointSeg(d, a, b))
}

/**
 * Does the eraser segment a→b (sheet pts of `stroke`'s sheet) touch the stroke?
 * `radius` is the eraser radius in sheet pts; the stroke's own half-width is added.
 */
export function eraserTouches(stroke: Pick<Stroke, 'points' | 'size'>, bb: Rect, a: Point, b: Point, radius: number): boolean {
  const reach = radius + stroke.size / 2
  const ex0 = Math.min(a.x, b.x) - reach
  const ey0 = Math.min(a.y, b.y) - reach
  const ex1 = Math.max(a.x, b.x) + reach
  const ey1 = Math.max(a.y, b.y) + reach
  if (bb.x > ex1 || bb.x + bb.w < ex0 || bb.y > ey1 || bb.y + bb.h < ey0) return false
  const pts = stroke.points
  if (pts.length === 1) return distPointSeg(pts[0], a, b) <= reach
  for (let i = 1; i < pts.length; i++) if (segDistance(a, b, pts[i - 1], pts[i]) <= reach) return true
  return false
}
