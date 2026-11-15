/**
 * A synthetic photo-import case, built without any image library so the pipeline can be tested in Node:
 * a floor-plan-like sheet raster, hand markup on it, and a "phone photo" of the two (perspective, table
 * around the sheet, uneven light, sensor noise). Deterministic (seeded).
 */
import type { RgbImage } from '../../../src/app/photo/pipeline/raster'

type Pt = [number, number]

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Anti-aliased coverage of a thick polyline: 0..1 per pixel (distance to the nearest segment). */
function strokeCoverage(cov: Float32Array, w: number, h: number, pts: Pt[], width: number) {
  const r = width / 2
  for (let k = 0; k + 1 < pts.length || (pts.length === 1 && k === 0); k++) {
    const [ax, ay] = pts[k]
    const [bx, by] = pts[Math.min(k + 1, pts.length - 1)]
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1))
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1))
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1))
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1))
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax
        const py = y + 0.5 - ay
        const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0
        const d = Math.hypot(px - t * dx, py - t * dy)
        const c = Math.max(0, Math.min(1, r - d + 0.5))
        const i = y * w + x
        if (c > cov[i]) cov[i] = c
      }
  }
}

function paint(rgb: Uint8Array, cov: Float32Array, color: readonly number[]) {
  for (let i = 0; i < cov.length; i++) {
    const c = cov[i]
    if (!c) continue
    for (let k = 0; k < 3; k++) rgb[i * 3 + k] = rgb[i * 3 + k] * (1 - c) + color[k] * c
  }
}

const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
]

export interface SyntheticCase {
  /** The sheet as printed, at `dpi`. */
  ref: RgbImage
  dpi: number
  /** Sheet size in points. */
  sizePt: { w: number; h: number }
  photo: RgbImage
  /** The markup that was drawn, in sheet points. */
  truth: { name: string; color: [number, number, number]; widthPt: number; points: Pt[] }[]
}

/**
 * @param w,h sheet raster size in px; the sheet is rendered at `dpi` (default: an A3 sheet at 100 dpi)
 * @param photoScale photo pixels per sheet pixel. The app works at about twice the resolution the photo has on
 *   the sheet, so a realistic photo is about half as sharp as the sheet raster.
 * @param drawing false: a blank sheet (nothing to register against)
 */
export function makeSyntheticCase({ w = 1654, h = 1170, dpi = 100, seed = 11, drawing = true, photoScale = 0.55 }: { w?: number; h?: number; dpi?: number; seed?: number; drawing?: boolean; photoScale?: number } = {}): SyntheticCase {
  const rnd = mulberry32(seed)
  const R = (a: number, b: number) => a + (b - a) * rnd()
  const s = dpi / 72

  // ── the drawing: border, rooms by recursive subdivision, furniture, tick "text", a title block
  const lines = new Float32Array(w * h)
  const thin = new Float32Array(w * h)
  if (drawing) {
    strokeCoverage(lines, w, h, rect(24 * s, 24 * s, w - 48 * s, h - 48 * s), 2 * s)
    const rooms: { x: number; y: number; w: number; h: number }[] = []
    const split = (r: { x: number; y: number; w: number; h: number }, depth: number) => {
      const canV = r.w > 190 * s
      const canH = r.h > 160 * s
      if (depth > 5 || (!canV && !canH) || (depth > 2 && rnd() < 0.15)) return void rooms.push(r)
      if (canV && (!canH || r.w / r.h > R(0.8, 1.4))) {
        const c = r.w * R(0.35, 0.65)
        split({ x: r.x, y: r.y, w: c, h: r.h }, depth + 1)
        split({ x: r.x + c, y: r.y, w: r.w - c, h: r.h }, depth + 1)
      } else {
        const c = r.h * R(0.35, 0.65)
        split({ x: r.x, y: r.y, w: r.w, h: c }, depth + 1)
        split({ x: r.x, y: r.y + c, w: r.w, h: r.h - c }, depth + 1)
      }
    }
    split({ x: 70 * s, y: 80 * s, w: w - 300 * s, h: h - 160 * s }, 0)
    for (const r of rooms) {
      strokeCoverage(lines, w, h, rect(r.x, r.y, r.w, r.h), 2.2 * s)
      strokeCoverage(thin, w, h, rect(r.x + 4 * s, r.y + 4 * s, r.w - 8 * s, r.h - 8 * s), 0.7 * s)
      // furniture
      for (let k = 0, n = 1 + Math.floor(R(0, 4)); k < n; k++) {
        const fw = R(18, 46) * s
        const fh = R(14, 30) * s
        strokeCoverage(thin, w, h, rect(r.x + R(10 * s, Math.max(11 * s, r.w - fw - 10 * s)), r.y + R(10 * s, Math.max(11 * s, r.h - fh - 10 * s)), fw, fh), 0.7 * s)
      }
      // a room tag: a few short strokes that read as text
      let tx = r.x + r.w / 2 - 22 * s
      const ty = r.y + r.h / 2
      for (let k = 0; k < 9; k++) {
        const up = R(3, 7) * s
        strokeCoverage(thin, w, h, [[tx, ty + R(-1, 1) * s], [tx + R(-2, 2) * s, ty - up], [tx + R(1, 4) * s, ty + R(-2, 2) * s]], 0.8 * s)
        tx += R(4, 7) * s
      }
    }
    // title block
    const tb = { x: w - 210 * s, y: 40 * s, w: 170 * s, h: h - 80 * s }
    strokeCoverage(lines, w, h, rect(tb.x, tb.y, tb.w, tb.h), 1.4 * s)
    for (let y = tb.y + 40 * s; y < tb.y + tb.h - 20 * s; y += R(26, 70) * s) {
      strokeCoverage(thin, w, h, [[tb.x, y], [tb.x + tb.w, y]], 0.7 * s)
      let tx = tb.x + 10 * s
      for (let k = 0; k < 14; k++) {
        strokeCoverage(thin, w, h, [[tx, y - 6 * s], [tx + R(-2, 2) * s, y - R(10, 16) * s], [tx + R(2, 5) * s, y - R(6, 14) * s]], 0.8 * s)
        tx += R(5, 9) * s
      }
    }
  }
  const ref = new Uint8Array(w * h * 3).fill(255)
  paint(ref, lines, [20, 20, 20])
  paint(ref, thin, [50, 50, 50])

  // ── the markup, in sheet points
  const circle: Pt[] = Array.from({ length: 49 }, (_, i): Pt => [w / s / 2 + 110 + 60 * Math.cos((i / 48) * 2 * Math.PI), h / s / 2 + 40 + 42 * Math.sin((i / 48) * 2 * Math.PI)])
  const truth: SyntheticCase['truth'] = [
    { name: 'red', color: [205, 32, 44], widthPt: 2.4, points: [[150, 170], [330, 170], [330, 300], [240, 360]] },
    { name: 'blue', color: [30, 78, 200], widthPt: 2.8, points: circle },
  ]
  const inked = Uint8Array.from(ref)
  for (const t of truth) {
    const cov = new Float32Array(w * h)
    strokeCoverage(cov, w, h, t.points.map(([x, y]): Pt => [x * s, y * s]), t.widthPt * s)
    paint(inked, cov, t.color)
  }

  // ── the photo: the sheet on a table, seen at an angle, lit unevenly
  const pw = Math.round(w * photoScale * 1.16)
  const ph = Math.round(h * photoScale * 1.2)
  // photo px -> sheet px (the inverse of a mild perspective view)
  const k = 1 / photoScale
  const H = [k, 0.045 * k, -0.11 * w, -0.04 * k, k * 1.02, -0.09 * h, 0.000028 * k, 0.000023 * k, 1]
  const sharp = new Float32Array(pw * ph * 3)
  const table = [104, 86, 70]
  const SS = 3 // sub-samples per axis: the lens averages over the pixel, it does not point-sample
  const acc = [0, 0, 0]
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      acc[0] = acc[1] = acc[2] = 0
      for (let j = 0; j < SS; j++)
        for (let i = 0; i < SS; i++) {
          const u = x + (i + 0.5) / SS
          const v = y + (j + 0.5) / SS
          const q = H[6] * u + H[7] * v + H[8]
          const sx = (H[0] * u + H[1] * v + H[2]) / q - 0.5
          const sy = (H[3] * u + H[4] * v + H[5]) / q - 0.5
          if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) {
            for (let c = 0; c < 3; c++) acc[c] += table[c]
            continue
          }
          const x0 = sx | 0
          const y0 = sy | 0
          const fx = sx - x0
          const fy = sy - y0
          const n = (y0 * w + x0) * 3
          for (let c = 0; c < 3; c++) acc[c] += 0.94 * ((inked[n + c] * (1 - fx) + inked[n + 3 + c] * fx) * (1 - fy) + (inked[n + w * 3 + c] * (1 - fx) + inked[n + w * 3 + 3 + c] * fx) * fy)
        }
      const o = (y * pw + x) * 3
      for (let c = 0; c < 3; c++) sharp[o + c] = acc[c] / (SS * SS)
    }
  // lens and demosaicing blur (sigma 0.8 px), then light fall-off and sensor noise
  const G = [-2, -1, 0, 1, 2].map((d) => Math.exp(-(d * d) / (2 * 0.8 * 0.8)))
  const gsum = G.reduce((p, q) => p + q, 0)
  const tmp = new Float32Array(sharp.length)
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++)
      for (let c = 0; c < 3; c++) {
        let v = 0
        for (let d = -2; d <= 2; d++) v += sharp[(y * pw + Math.max(0, Math.min(pw - 1, x + d))) * 3 + c] * G[d + 2]
        tmp[(y * pw + x) * 3 + c] = v / gsum
      }
  const photo = new Uint8Array(pw * ph * 3)
  for (let y = 0; y < ph; y++)
    for (let x = 0; x < pw; x++) {
      const light = 0.97 - 0.16 * (x / pw) - 0.08 * (y / ph)
      const noise = (rnd() - 0.5) * 6
      for (let c = 0; c < 3; c++) {
        let v = 0
        for (let d = -2; d <= 2; d++) v += tmp[(Math.max(0, Math.min(ph - 1, y + d)) * pw + x) * 3 + c] * G[d + 2]
        photo[(y * pw + x) * 3 + c] = Math.max(0, Math.min(255, (v / gsum) * light + noise))
      }
    }
  return { ref: { rgb: ref, w, h }, dpi, sizePt: { w: w / s, h: h / s }, photo: { rgb: photo, w: pw, h: ph }, truth }
}

/** Distance from a point to a polyline (same units). */
export function distanceToPolyline(p: readonly [number, number], poly: readonly Pt[]): number {
  let best = Infinity
  for (let k = 0; k + 1 < poly.length; k++) {
    const [ax, ay] = poly[k]
    const [bx, by] = poly[k + 1]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy))
  }
  return best
}
