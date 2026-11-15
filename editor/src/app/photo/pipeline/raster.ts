/**
 * Raster helpers and 3x3 homography maths for the photo pipeline. No DOM: rasters are plain typed arrays
 * (8-bit, 1 or 3 channels, row-major), so the pipeline runs the same in a Web Worker and in Node.
 */
import type { Cv, Mat } from './cv'

/** An 8-bit RGB image. */
export interface RgbImage {
  rgb: Uint8Array
  w: number
  h: number
}

/** An 8-bit grey image. */
export interface GrayImage {
  data: Uint8Array
  w: number
  h: number
}

/** Row-major 3x3 matrix. */
export type Mat3 = number[]

export type Log = (line: string) => void

export function rgbToGray(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < g.length; i++, j += 3) g[i] = (rgb[j] * 77 + rgb[j + 1] * 150 + rgb[j + 2] * 29) >> 8
  return g
}

/** RGBA (canvas `ImageData`) to RGB. Transparent pixels are composited on white. */
export function rgbaToRgb(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    const a = rgba[j + 3]
    if (a === 255) {
      rgb[i] = rgba[j]
      rgb[i + 1] = rgba[j + 1]
      rgb[i + 2] = rgba[j + 2]
    } else {
      const k = a / 255
      rgb[i] = rgba[j] * k + 255 * (1 - k)
      rgb[i + 1] = rgba[j + 1] * k + 255 * (1 - k)
      rgb[i + 2] = rgba[j + 2] * k + 255 * (1 - k)
    }
  }
  return rgb
}

const toMatN = (cv: Cv, data: Uint8Array, w: number, h: number, channels: number): Mat => {
  const m = new cv.Mat(h, w, channels === 3 ? cv.CV_8UC3 : cv.CV_8UC1)
  m.data.set(data)
  return m
}

/** Taps of a Lanczos-3 reduction along one axis: for every output index, the first source index and the weights. */
function lanczosTaps(n: number, nn: number): { start: Int32Array; weights: Float32Array; count: number } {
  const shrink = n / nn
  const count = Math.round(6 * shrink) + 1
  const start = new Int32Array(nn)
  const weights = new Float32Array(nn * count)
  for (let o = 0; o < nn; o++) {
    const c = (o + 0.5) * shrink - 0.5 // centre of the output pixel in source coordinates
    const first = Math.ceil(c - 3 * shrink)
    start[o] = first
    let sum = 0
    for (let k = 0; k < count; k++) {
      const xp = (first + k - c) / shrink
      const l = xp === 0 ? 1 : Math.abs(xp) >= 3 ? 0 : (3 * Math.sin(Math.PI * xp) * Math.sin((Math.PI * xp) / 3)) / (Math.PI * Math.PI * xp * xp)
      weights[o * count + k] = l
      sum += l
    }
    for (let k = 0; k < count; k++) weights[o * count + k] /= sum
  }
  return { start, weights, count }
}

/**
 * Shrink with a Lanczos-3 kernel widened by the shrink factor (what sharp/libvips does). The registration's
 * tile matching was tuned on images this sharp: area averaging is softer and loses a little accuracy at the
 * sheet margins.
 */
function lanczosReduce(data: Uint8Array, w: number, h: number, ch: number, nw: number, nh: number): Uint8Array {
  // Sums are rounded to float32 after every tap (Math.fround), as they were when they were accumulated in a
  // Float32Array: the result stays bit-for-bit what it was, only quicker (no clamping inside the loop, channels
  // unrolled).
  const f = Math.fround
  // horizontal pass
  const tx = lanczosTaps(w, nw)
  const cnt = tx.count
  // per output column, its taps' source columns, clamped to the image (in elements, not pixels)
  const cols = new Int32Array(nw * cnt)
  for (let x = 0; x < nw; x++) for (let k = 0; k < cnt; k++) { const sx = tx.start[x] + k; cols[x * cnt + k] = (sx < 0 ? 0 : sx >= w ? w - 1 : sx) * ch }
  const tw = tx.weights
  const mid = new Float32Array(nw * h * ch)
  for (let y = 0; y < h; y++) {
    const row = y * w * ch
    if (ch === 3) {
      for (let x = 0, o = y * nw * 3; x < nw; x++, o += 3) {
        let a0 = 0, a1 = 0, a2 = 0
        for (let k = 0, j = x * cnt; k < cnt; k++, j++) {
          const i = row + cols[j], wt = tw[j]
          a0 = f(a0 + data[i] * wt)
          a1 = f(a1 + data[i + 1] * wt)
          a2 = f(a2 + data[i + 2] * wt)
        }
        mid[o] = a0
        mid[o + 1] = a1
        mid[o + 2] = a2
      }
    } else if (ch === 1) {
      for (let x = 0, o = y * nw; x < nw; x++, o++) {
        let a = 0
        for (let k = 0, j = x * cnt; k < cnt; k++, j++) a = f(a + data[row + cols[j]] * tw[j])
        mid[o] = a
      }
    } else {
      for (let x = 0; x < nw; x++) {
        const o = (y * nw + x) * ch
        for (let k = 0, j = x * cnt; k < cnt; k++, j++) {
          const i = row + cols[j], wt = tw[j]
          for (let c = 0; c < ch; c++) mid[o + c] += data[i + c] * wt
        }
      }
    }
  }
  // vertical pass
  const ty = lanczosTaps(h, nh)
  const out = new Uint8Array(nw * nh * ch)
  const acc = new Float32Array(nw * ch)
  const n = acc.length
  for (let y = 0; y < nh; y++) {
    acc.fill(0)
    const s0 = ty.start[y]
    const wo = y * ty.count
    for (let k = 0; k < ty.count; k++) {
      const sy = s0 + k
      const row = (sy < 0 ? 0 : sy >= h ? h - 1 : sy) * n
      const wt = ty.weights[wo + k]
      for (let i = 0; i < n; i++) acc[i] += mid[row + i] * wt
    }
    const o = y * n
    for (let i = 0; i < n; i++) {
      const v = acc[i]
      out[o + i] = v <= 0 ? 0 : v >= 255 ? 255 : v + 0.5
    }
  }
  return out
}

/** Resize a 1- or 3-channel 8-bit raster (Lanczos-3 when shrinking, cubic when enlarging). */
export function resizeRaw(cv: Cv, data: Uint8Array, w: number, h: number, channels: number, nw: number, nh: number): Uint8Array {
  if (nw === w && nh === h) return Uint8Array.from(data)
  if (nw <= w && nh <= h) return lanczosReduce(data, w, h, channels, nw, nh)
  const src = toMatN(cv, data, w, h, channels)
  const dst = new cv.Mat()
  cv.resize(src, dst, new cv.Size(nw, nh), 0, 0, cv.INTER_CUBIC)
  const out = Uint8Array.from(dst.data as Uint8Array)
  src.delete()
  dst.delete()
  return out
}

/**
 * Gaussian blur of a 1- or 3-channel 8-bit raster.
 * The kernel is the one libvips (sharp) builds: cut off where the Gaussian falls below 0.2 and rounded to
 * twentieths, which is narrower than OpenCV's own. The pipeline's thresholds were tuned with it: a wider blur
 * of the rendered drawing makes its thin lines look fainter than the photo shows them, and they turn into "ink".
 */
export function blurRaw(cv: Cv, data: Uint8Array, w: number, h: number, channels: number, sigma: number): Uint8Array {
  const sig2 = 2 * sigma * sigma
  let x = 0
  for (const max = Math.min(5000, 8 * sigma); x < max; x++) if (Math.exp((-x * x) / sig2) < 0.2) break
  const r = Math.max(x - 1, 0)
  const taps: number[] = []
  for (let i = -r; i <= r; i++) taps.push(Math.round(20 * Math.exp((-i * i) / sig2)))
  const sum = taps.reduce((p, q) => p + q, 0)
  const kernel = cv.matFromArray(1, taps.length, cv.CV_32F, taps.map((v) => v / sum))
  const src = toMatN(cv, data, w, h, channels)
  const dst = new cv.Mat()
  cv.sepFilter2D(src, dst, -1, kernel, kernel, new cv.Point(-1, -1), 0, cv.BORDER_REPLICATE)
  const out = Uint8Array.from(dst.data as Uint8Array)
  src.delete()
  dst.delete()
  kernel.delete()
  return out
}

// ---- 3x3 homography maths (row-major arrays of 9) ----

export function matMul3(a: Mat3, b: Mat3): Mat3 {
  const o = new Array<number>(9)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
  return o
}

export function matInv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-18) throw new Error('singular homography')
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det)
}

export function applyH(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8]
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
}

export const scaleMat = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1]
