// Stage 3 (fills): outline what is too thick to be a pen stroke (a marker fill).
// Boundary pixels -> smoothed closed polygon -> simplified. Ported from the trace-markup project.
import type { Cv } from './cv'

type Pt = [number, number]

function smoothClosed(pts: Float64Array, sigma: number): Float64Array {
  const n = pts.length >> 1
  if (n < 12 || sigma <= 0) return Float64Array.from(pts)
  const rad = Math.min(Math.ceil(sigma * 3), (n - 1) >> 1)
  const k: number[] = []
  let sum = 0
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k.push(v)
    sum += v
  }
  const out = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    let x = 0
    let y = 0
    for (let j = -rad; j <= rad; j++) {
      const q = (i + j + n) % n
      const wv = k[j + rad]
      x += pts[q * 2] * wv
      y += pts[q * 2 + 1] * wv
    }
    out[i * 2] = x / sum
    out[i * 2 + 1] = y / sum
  }
  return out
}

/** Ramer-Douglas-Peucker on a closed polygon; returns kept vertex indices in order. */
function simplifyClosed(pts: Float64Array, eps: number): number[] {
  const n = pts.length >> 1
  if (n <= 4) return Array.from({ length: n }, (_, i) => i)
  let far = 0
  let fd = -1
  for (let i = 1; i < n; i++) {
    const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2
    if (d > fd) {
      fd = d
      far = i
    }
  }
  const keep = new Uint8Array(n + 1)
  keep[0] = keep[far] = keep[n] = 1
  const X = (i: number) => pts[(i % n) * 2]
  const Y = (i: number) => pts[(i % n) * 2 + 1]
  const stack: [number, number][] = [
    [0, far],
    [far, n],
  ]
  while (stack.length) {
    const [a, b] = stack.pop()!
    if (b - a < 2) continue
    const ax = X(a)
    const ay = Y(a)
    const dx = X(b) - ax
    const dy = Y(b) - ay
    const len = Math.hypot(dx, dy) || 1e-9
    let worst = -1
    let wi = -1
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((X(i) - ax) * dy - (Y(i) - ay) * dx) / len
      if (d > worst) {
        worst = d
        wi = i
      }
    }
    if (worst > eps) {
      keep[wi] = 1
      stack.push([a, wi], [wi, b])
    }
  }
  const idx: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i)
  return idx
}

/**
 * Outlines of the blobs in a mask, as closed polygons (the first point is not repeated).
 * @param mask 0/1 at w x h
 * @param pxToPt output units per mask pixel
 * @returns one polygon per outer boundary and per hole
 */
export function traceOutlines(
  cv: Cv,
  mask: Uint8Array,
  w: number,
  h: number,
  pxToPt: number,
  { smooth = 1.2, tolerance = 0.5, minArea = 40 }: { smooth?: number; tolerance?: number; minArea?: number } = {},
): Pt[][] {
  const m = new cv.Mat(h, w, cv.CV_8UC1)
  const md = m.data as Uint8Array
  for (let i = 0; i < mask.length; i++) md[i] = mask[i] ? 255 : 0
  const contours = new cv.MatVector()
  const hier = new cv.Mat()
  cv.findContours(m, contours, hier, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE)
  const H = hier.data32S as Int32Array
  const count = contours.size() as number
  const out: Pt[][] = []
  for (let i = 0; i < count; i++) {
    const isHole = H[i * 4 + 3] !== -1
    const c = contours.get(i)
    const raw = Float64Array.from(c.data32S as Int32Array)
    c.delete()
    const n = raw.length >> 1
    let area = 0
    for (let k = 0; k < n; k++) {
      const q = (k + 1) % n
      area += raw[k * 2] * raw[q * 2 + 1] - raw[q * 2] * raw[k * 2 + 1]
    }
    if (Math.abs(area) / 2 < (isHole ? minArea / 4 : minArea) || n < 4) continue
    const sm = smoothClosed(raw, smooth)
    // The contour runs through the centres of the edge pixels, half a pixel inside the true edge:
    // push it out along the normal (for a hole that means shrinking the hole).
    const dir = (area > 0 ? 1 : -1) * (isHole ? -1 : 1) * 0.5
    if (n >= 12) {
      const moved = new Float64Array(sm.length)
      for (let k = 0; k < n; k++) {
        const a = (k - 1 + n) % n
        const b = (k + 1) % n
        const tx = sm[b * 2] - sm[a * 2]
        const ty = sm[b * 2 + 1] - sm[a * 2 + 1]
        const tl = Math.hypot(tx, ty) || 1
        moved[k * 2] = sm[k * 2] + (ty / tl) * dir
        moved[k * 2 + 1] = sm[k * 2 + 1] - (tx / tl) * dir
      }
      sm.set(moved)
    }
    const idx = simplifyClosed(sm, tolerance)
    if (idx.length < 3) continue
    // +0.5: contour points are pixel centres, the sheet frame has its origin at the pixel corner
    out.push(idx.map((k): Pt => [(sm[k * 2] + 0.5) * pxToPt, (sm[k * 2 + 1] + 0.5) * pxToPt]))
  }
  m.delete()
  contours.delete()
  hier.delete()
  return out
}
