import type { Path, Point, PrimitiveFit } from '../types'
import { resampleByCount, simplifyIndices, smoothMovingAverage } from './resample'
import {
  angle,
  angleDiffSigned,
  bbox,
  closestPointOnPolyline,
  convexHull,
  dist,
  lineIntersection,
  polygonArea,
  polylineLength,
  sub,
} from './vec'

/**
 * Primitive fitting. All fits share one normalisation: the RMS residual is
 * divided by the stroke length (so it is scale free), then mapped through
 * score = exp(-(rel / TOL)^2). Scores are therefore comparable across kinds.
 */
export const FIT_SAMPLES = 64
const TOL = 0.03
/** Closed when end-to-start distance is under this fraction of the length. */
export const CLOSED_RATIO = 0.15
const CORNER_MIN_TURN = (55 * Math.PI) / 180
const REVERSAL_MIN_TURN = (100 * Math.PI) / 180
const MIN_ARC_SWEEP = (20 * Math.PI) / 180

export interface Prepared {
  /** Smoothed, arc-length resampled points (FIT_SAMPLES). */
  pts: Point[]
  length: number
  closureRatio: number
  closed: boolean
  diag: number
}

export function prepareForFit(raw: readonly Point[], smoothing = 0): Prepared | null {
  if (raw.length < 2) return null
  const sm = smoothing > 0 ? smoothMovingAverage(raw, smoothing) : (raw as Point[])
  const length = polylineLength(sm)
  if (length < 1e-6) return null
  const pts = resampleByCount(sm, FIT_SAMPLES)
  const closureRatio = dist(sm[0], sm[sm.length - 1]) / length
  const bb = bbox(pts)
  return { pts, length, closureRatio, closed: closureRatio < CLOSED_RATIO, diag: Math.hypot(bb.w, bb.h) }
}

const sc = (rel: number): number => Math.exp(-((rel / TOL) * (rel / TOL)))
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const mkFit = (kind: PrimitiveFit['kind'], points: Point[], closed: boolean, residual: number, score: number): PrimitiveFit => ({
  kind,
  path: { points, closed },
  residual,
  score: clamp01(score),
})

// ───────────────────────────── line ─────────────────────────────

export interface LineFit {
  a: Point
  b: Point
  /** Direction angle of the fitted line, radians. */
  angle: number
  rms: number
}

/** Total least squares line through points; endpoints are the projections of the first and last point. */
export function fitLineTLS(pts: readonly Point[]): LineFit | null {
  const n = pts.length
  if (n < 2) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of pts) {
    const dx = p.x - mx
    const dy = p.y - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const ux = Math.cos(th)
  const uy = Math.sin(th)
  let ss = 0
  for (const p of pts) {
    const d = -(p.x - mx) * uy + (p.y - my) * ux
    ss += d * d
  }
  const proj = (p: Point): Point => {
    const t = (p.x - mx) * ux + (p.y - my) * uy
    return { x: mx + ux * t, y: my + uy * t }
  }
  const a = proj(pts[0])
  const b = proj(pts[n - 1])
  const dir = angle(sub(b, a))
  return { a, b, angle: dist(a, b) < 1e-9 ? th : dir, rms: Math.sqrt(ss / n) }
}

function lineFromPrep(p: Prepared): PrimitiveFit | null {
  const f = fitLineTLS(p.pts)
  if (!f) return null
  const chord = dist(p.pts[0], p.pts[p.pts.length - 1])
  const straight = chord / p.length
  const rel = f.rms / p.length
  return mkFit('line', [f.a, f.b], false, f.rms, sc(rel) * straight * straight * (p.closed ? 0.1 : 1))
}

export function fitLine(points: readonly Point[], smoothing = 0): PrimitiveFit | null {
  const p = prepareForFit(points, smoothing)
  return p ? lineFromPrep(p) : null
}

// ───────────────────────────── corners / polyline ─────────────────────────────

/** Indices (into Prepared.pts) of sharp corners, in order. */
export function cornerIndices(p: Prepared): number[] {
  const n = p.pts.length
  const k = 4
  const turn = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let i0 = i - k
    let i1 = i + k
    if (p.closed) {
      i0 = (i0 + n) % n
      i1 = i1 % n
    } else if (i0 < 0 || i1 >= n) continue
    const v1 = sub(p.pts[i], p.pts[i0])
    const v2 = sub(p.pts[i1], p.pts[i])
    if (Math.hypot(v1.x, v1.y) < 1e-9 || Math.hypot(v2.x, v2.y) < 1e-9) continue
    turn[i] = Math.abs(angleDiffSigned(angle(v2), angle(v1)))
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    if (turn[i] < CORNER_MIN_TURN) continue
    let isMax = true
    for (let j = -k; j <= k && isMax; j++) {
      if (j === 0) continue
      let q = i + j
      if (p.closed) q = (q + n) % n
      else if (q < 0 || q >= n) continue
      if (turn[q] > turn[i] || (turn[q] === turn[i] && j < 0)) isMax = false
    }
    if (isMax) out.push(i)
  }
  if (p.closed && out.length > 1 && out[0] === 0 && out[out.length - 1] === n - 1) out.pop()
  return out
}

function polylineFromPrep(p: Prepared, corners: number[]): PrimitiveFit | null {
  if (corners.length === 0 || p.pts.length < 4) return null
  const n = p.pts.length
  const bps = [0, ...corners.filter((c) => c > 0 && c < n - 1), n - 1]
  const lines: LineFit[] = []
  for (let i = 0; i < bps.length - 1; i++) {
    const seg = p.pts.slice(bps[i], bps[i + 1] + 1)
    const f = fitLineTLS(seg)
    if (!f) return null
    lines.push(f)
  }
  const verts: Point[] = [lines[0].a]
  for (let i = 0; i < lines.length - 1; i++) {
    const x = lineIntersection(lines[i].a, lines[i].b, lines[i + 1].a, lines[i + 1].b)
    const corner = p.pts[bps[i + 1]]
    verts.push(x && dist(x, corner) < 0.15 * p.length ? x : corner)
  }
  verts.push(lines[lines.length - 1].b)
  let ss = 0
  for (const q of p.pts) {
    const d = closestPointOnPolyline(q, verts).distance
    ss += d * d
  }
  const rms = Math.sqrt(ss / n)
  const segs = verts.length - 1
  const penalty = 1 / (1 + 0.15 * Math.max(0, segs - 2))
  return mkFit('polyline', verts, false, rms, sc(rms / p.length) * penalty * (p.closed ? 0.6 : 1))
}

export function fitPolyline(points: readonly Point[], smoothing = 0): PrimitiveFit | null {
  const p = prepareForFit(points, smoothing)
  return p ? polylineFromPrep(p, cornerIndices(p)) : null
}

export function detectCorners(points: readonly Point[], smoothing = 0): Point[] {
  const p = prepareForFit(points, smoothing)
  return p ? cornerIndices(p).map((i) => p.pts[i]) : []
}

// ───────────────────────────── reversals / scribble ─────────────────────────────

/** Number of sharp direction reversals (turn > 100 degrees at significant vertices). */
export function reversalCount(p: Prepared): number {
  const eps = Math.max(0.03 * p.length, 0.5)
  const idx = simplifyIndices(p.pts, eps)
  let c = 0
  for (let i = 1; i < idx.length - 1; i++) {
    const a = p.pts[idx[i - 1]]
    const b = p.pts[idx[i]]
    const d = p.pts[idx[i + 1]]
    const t = Math.abs(angleDiffSigned(angle(sub(d, b)), angle(sub(b, a))))
    if (t > REVERSAL_MIN_TURN) c++
  }
  return c
}

function scribbleFromPrep(p: Prepared, reversals: number): PrimitiveFit | null {
  if (reversals < 2) return null
  const bb = bbox(p.pts)
  const rect: Point[] = [
    { x: bb.x, y: bb.y },
    { x: bb.x + bb.w, y: bb.y },
    { x: bb.x + bb.w, y: bb.y + bb.h },
    { x: bb.x, y: bb.y + bb.h },
  ]
  const lf = fitLineTLS(p.pts)
  return mkFit('scribble', rect, true, lf ? lf.rms : 0, clamp01((reversals - 1) / 4))
}

export function fitScribble(points: readonly Point[], smoothing = 0): PrimitiveFit | null {
  const p = prepareForFit(points, smoothing)
  return p ? scribbleFromPrep(p, reversalCount(p)) : null
}

// ───────────────────────────── arc ─────────────────────────────

export interface CircleFit {
  cx: number
  cy: number
  r: number
  rms: number
}

/** Algebraic (Kasa) circle fit on centred coordinates. Null for collinear points. */
export function fitCircleKasa(pts: readonly Point[]): CircleFit | null {
  const n = pts.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let suu = 0
  let svv = 0
  let suv = 0
  let suuu = 0
  let svvv = 0
  let suvv = 0
  let suuv = 0
  for (const p of pts) {
    const u = p.x - mx
    const v = p.y - my
    suu += u * u
    svv += v * v
    suv += u * v
    suuu += u * u * u
    svvv += v * v * v
    suvv += u * v * v
    suuv += u * u * v
  }
  const det = suu * svv - suv * suv
  if (Math.abs(det) < 1e-9 * Math.max(1, suu * svv)) return null
  const r1 = 0.5 * (suuu + suvv)
  const r2 = 0.5 * (svvv + suuv)
  const a = (r1 * svv - r2 * suv) / det
  const b = (r2 * suu - r1 * suv) / det
  const r = Math.sqrt(a * a + b * b + (suu + svv) / n)
  const cx = mx + a
  const cy = my + b
  let ss = 0
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy) - r
    ss += d * d
  }
  return { cx, cy, r, rms: Math.sqrt(ss / n) }
}

function arcFromPrep(p: Prepared): PrimitiveFit | null {
  const c = fitCircleKasa(p.pts)
  if (!c || c.r > 20 * p.length) return null
  // unwrap angles along the stroke to get a signed sweep
  let prev = Math.atan2(p.pts[0].y - c.cy, p.pts[0].x - c.cx)
  const start = prev
  let sweep = 0
  for (let i = 1; i < p.pts.length; i++) {
    const a = Math.atan2(p.pts[i].y - c.cy, p.pts[i].x - c.cx)
    sweep += angleDiffSigned(a, prev)
    prev = a
  }
  if (Math.abs(sweep) < MIN_ARC_SWEEP) return null
  const full = Math.abs(sweep) >= (330 * Math.PI) / 180
  const total = full ? Math.sign(sweep) * 2 * Math.PI : sweep
  const m = Math.max(8, Math.ceil((Math.abs(total) / (Math.PI / 2)) * 8))
  const out: Point[] = []
  const steps = full ? m : m
  for (let i = 0; i <= steps; i++) {
    if (full && i === steps) break
    const a = start + (total * i) / steps
    out.push({ x: c.cx + c.r * Math.cos(a), y: c.cy + c.r * Math.sin(a) })
  }
  return mkFit('arc', out, full, c.rms, sc(c.rms / p.length))
}

export function fitArc(points: readonly Point[], smoothing = 0): PrimitiveFit | null {
  const p = prepareForFit(points, smoothing)
  return p ? arcFromPrep(p) : null
}

// ───────────────────────────── rectangle / blob ─────────────────────────────

export interface OrientedRect {
  corners: [Point, Point, Point, Point]
  angle: number
  w: number
  h: number
}

/** Minimum-area oriented bounding rectangle (rotating over convex hull edges). */
export function minAreaRect(pts: readonly Point[]): OrientedRect | null {
  const hull = convexHull(pts)
  if (hull.length < 3) return null
  let best: OrientedRect | null = null
  let bestArea = Infinity
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    const th = angle(sub(b, a))
    const c = Math.cos(th)
    const s = Math.sin(th)
    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const q of hull) {
      const u = q.x * c + q.y * s
      const v = -q.x * s + q.y * c
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (area < bestArea) {
      bestArea = area
      const back = (u: number, v: number): Point => ({ x: u * c - v * s, y: u * s + v * c })
      best = {
        corners: [back(minU, minV), back(maxU, minV), back(maxU, maxV), back(minU, maxV)],
        angle: th,
        w: maxU - minU,
        h: maxV - minV,
      }
    }
  }
  return best
}

function compactness(p: Prepared): number {
  const per = polylineLength(p.pts, true)
  return per < 1e-9 ? 0 : (4 * Math.PI * polygonArea(p.pts)) / (per * per)
}

const closureScore = (p: Prepared): number => clamp01(1 - p.closureRatio / (2 * CLOSED_RATIO))

function rectangleFromPrep(p: Prepared): PrimitiveFit | null {
  const r = minAreaRect(p.pts)
  if (!r || r.w < 1e-6 || r.h < 1e-6) return null
  const cs = r.corners
  const loop = [...cs, cs[0]]
  let ss = 0
  let sumD = 0
  for (const q of p.pts) {
    const d = closestPointOnPolyline(q, loop).distance
    ss += d * d
    sumD += d
  }
  const n = p.pts.length
  let cornerD = 0
  for (const c of cs) {
    let m = Infinity
    for (const q of p.pts) m = Math.min(m, dist(c, q))
    cornerD += m
  }
  cornerD /= 4
  const perimeter = 2 * (r.w + r.h)
  const rel = (sumD / n + 0.5 * cornerD) / perimeter
  const score = sc(rel * (p.length > 0 ? 1 : 1)) * closureScore(p) * clamp01(compactness(p) / 0.15)
  return mkFit('rectangle', cs.slice(), true, Math.sqrt(ss / n), score)
}

export function fitRectangle(points: readonly Point[], smoothing = 0): PrimitiveFit | null {
  const p = prepareForFit(points, smoothing)
  return p ? rectangleFromPrep(p) : null
}

function blobFromPrep(p: Prepared): PrimitiveFit | null {
  if (!p.closed) return null
  const poly = resampleByCount(smoothMovingAverage(p.pts, 0.5), 32, true)
  let ss = 0
  for (const q of p.pts) {
    const d = closestPointOnPolyline(q, poly, true).distance
    ss += d * d
  }
  const rms = Math.sqrt(ss / p.pts.length)
  return mkFit('blob', poly, true, rms, 0.5 * closureScore(p) * clamp01(compactness(p) / 0.3))
}

export function fitBlob(points: readonly Point[], smoothing = 0): PrimitiveFit | null {
  const p = prepareForFit(points, smoothing)
  return p ? blobFromPrep(p) : null
}

// ───────────────────────────── all ─────────────────────────────

export interface FitAnalysis {
  fits: PrimitiveFit[]
  prepared: Prepared | null
  corners: number
  reversals: number
}

/** Run every fitter on a prepared stroke; fits sorted by descending score. */
export function analyzePrepared(p: Prepared): FitAnalysis {
  const cidx = cornerIndices(p)
  const reversals = reversalCount(p)
  const list: (PrimitiveFit | null)[] = [
    lineFromPrep(p),
    polylineFromPrep(p, cidx),
    arcFromPrep(p),
    rectangleFromPrep(p),
    blobFromPrep(p),
    scribbleFromPrep(p, reversals),
  ]
  const fits = list.filter((f): f is PrimitiveFit => f !== null)
  if (reversals >= 3) for (const f of fits) if (f.kind === 'polyline') f.score *= 0.4
  fits.sort((a, b) => b.score - a.score)
  return { fits, prepared: p, corners: cidx.length, reversals }
}

export function fitPrimitives(points: readonly Point[], opts: { smoothing?: number } = {}): PrimitiveFit[] {
  const p = prepareForFit(points, opts.smoothing ?? 0)
  return p ? analyzePrepared(p).fits : []
}

export type { Path }
