import type { Point } from '../types'
import { dist, lerp, polylineLength } from './vec'

/** Resample to exactly n points evenly spaced by arc length (endpoints kept when open). */
export function resampleByCount(pts: readonly Point[], n: number, closed = false): Point[] {
  if (pts.length === 0 || n <= 0) return []
  if (pts.length === 1 || n === 1) return Array.from({ length: Math.max(1, n) }, () => ({ ...pts[0] }))
  const src = closed ? [...pts, pts[0]] : pts
  const total = polylineLength(src)
  if (total < 1e-12) return Array.from({ length: n }, () => ({ ...pts[0] }))
  const out: Point[] = []
  const steps = closed ? n : n - 1
  const step = total / steps
  let seg = 0
  let acc = 0
  let segLen = dist(src[0], src[1])
  for (let i = 0; i < n; i++) {
    const target = Math.min(i * step, total)
    while (seg < src.length - 2 && acc + segLen < target) {
      acc += segLen
      seg++
      segLen = dist(src[seg], src[seg + 1])
    }
    const t = segLen < 1e-12 ? 0 : Math.min(1, (target - acc) / segLen)
    out.push(lerp(src[seg], src[seg + 1], t))
  }
  if (!closed) out[n - 1] = { ...pts[pts.length - 1] }
  return out
}

/** Resample at fixed spacing; the last point is always the original last point. */
export function resampleBySpacing(pts: readonly Point[], spacing: number): Point[] {
  if (pts.length < 2 || spacing <= 0) return pts.map((p) => ({ ...p }))
  const out: Point[] = [{ ...pts[0] }]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1]
    const b = pts[i]
    let d = dist(a, b)
    while (carry + d >= spacing && d > 1e-12) {
      a = lerp(a, b, (spacing - carry) / d)
      out.push(a)
      d = dist(a, b)
      carry = 0
    }
    carry += d
  }
  const last = pts[pts.length - 1]
  if (dist(out[out.length - 1], last) > 1e-9) out.push({ ...last })
  return out
}

/** Douglas-Peucker; returns the kept indices (iterative). */
export function simplifyIndices(pts: readonly Point[], epsilon: number): number[] {
  const n = pts.length
  if (n <= 2) return pts.map((_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: number[] = [0, n - 1]
  while (stack.length) {
    const hi = stack.pop() as number
    const lo = stack.pop() as number
    let maxD = -1
    let idx = -1
    const a = pts[lo]
    const b = pts[hi]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    for (let i = lo + 1; i < hi; i++) {
      const p = pts[i]
      let d: number
      if (l2 < 1e-18) d = Math.hypot(p.x - a.x, p.y - a.y)
      else {
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
      }
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > epsilon && idx >= 0) {
      keep[idx] = 1
      stack.push(lo, idx, idx, hi)
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

export function simplifyDP(pts: readonly Point[], epsilon: number): Point[] {
  return simplifyIndices(pts, epsilon).map((i) => ({ ...pts[i] }))
}

/** Moving-average smoothing, strength 0..1 (0 = identity). Endpoints preserved exactly. */
export function smoothMovingAverage(pts: readonly Point[], strength: number): Point[] {
  const n = pts.length
  const s = Math.max(0, Math.min(1, strength))
  const radius = Math.round(s * 6)
  if (n < 3 || radius === 0) return pts.map((p) => ({ ...p }))
  const passes = s > 0.6 ? 2 : 1
  let cur = pts.map((p) => ({ ...p }))
  for (let k = 0; k < passes; k++) {
    const next: Point[] = new Array(n)
    next[0] = cur[0]
    next[n - 1] = cur[n - 1]
    for (let i = 1; i < n - 1; i++) {
      const r = Math.min(radius, i, n - 1 - i)
      let sx = 0
      let sy = 0
      let w = 0
      for (let j = -r; j <= r; j++) {
        const wt = r + 1 - Math.abs(j)
        sx += cur[i + j].x * wt
        sy += cur[i + j].y * wt
        w += wt
      }
      next[i] = { x: sx / w, y: sy / w }
    }
    cur = next
  }
  return cur
}

/** Chaikin corner cutting; cut fraction = 0.25 * strength (0..1). Endpoints preserved. */
export function smoothChaikin(pts: readonly Point[], strength: number, iterations = 2): Point[] {
  const q = 0.25 * Math.max(0, Math.min(1, strength))
  let cur = pts.map((p) => ({ ...p }))
  if (q === 0) return cur
  for (let it = 0; it < iterations && cur.length > 2; it++) {
    const next: Point[] = [cur[0]]
    for (let i = 0; i < cur.length - 1; i++) {
      next.push(lerp(cur[i], cur[i + 1], q), lerp(cur[i], cur[i + 1], 1 - q))
    }
    next.push(cur[cur.length - 1])
    cur = next
  }
  return cur
}

export type SmoothMethod = 'moving-average' | 'chaikin'

export function smoothPolyline(pts: readonly Point[], strength: number, method: SmoothMethod = 'moving-average'): Point[] {
  return method === 'chaikin' ? smoothChaikin(pts, strength) : smoothMovingAverage(pts, strength)
}
