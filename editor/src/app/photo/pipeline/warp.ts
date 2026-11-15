/**
 * Sampling the photo in sheet space: the coarse displacement field that absorbs paper wrinkle, and the colour warp
 * of the photo through a homography and that field. PURE: no DOM, no OpenCV (also runs in the helper workers).
 */
import type { Mat3, RgbImage } from "./raster";

/** A coarse grid of displacements (px), bilinear in between. */
export interface Field { gw: number; gh: number; x0: number; y0: number; step: number; dx: Float32Array; dy: Float32Array }

/** A colour raster in sheet space, its coverage mask, and how many pixels the photo covers. */
export interface Warp { rgb: Uint8Array; valid: Uint8Array; covered: number }

const fieldTmp = [0, 0];
/** Bilinear lookup in a coarse displacement grid; (x, y) in the grid's own pixel frame. */
export function sampleField(f: Field, x: number, y: number): number[] {
  let gx = (x - f.x0) / f.step, gy = (y - f.y0) / f.step;
  gx = gx < 0 ? 0 : gx > f.gw - 1 ? f.gw - 1 : gx;
  gy = gy < 0 ? 0 : gy > f.gh - 1 ? f.gh - 1 : gy;
  const ix = Math.min(f.gw - 2, gx | 0), iy = Math.min(f.gh - 2, gy | 0), fx = gx - ix, fy = gy - iy, i = iy * f.gw + ix;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  fieldTmp[0] = f.dx[i] * w00 + f.dx[i + 1] * w10 + f.dx[i + f.gw] * w01 + f.dx[i + f.gw + 1] * w11;
  fieldTmp[1] = f.dy[i] * w00 + f.dy[i + 1] * w10 + f.dy[i + f.gw] * w01 + f.dy[i + f.gw + 1] * w11;
  return fieldTmp;
}

/**
 * Rows [r0, r1) of the bilinear colour warp of the photo into sheet space (`w` x `h`). `field` (optional) is in px
 * of a grid `fieldScale` times the output size. Each row comes out the same whichever band it is computed in, so
 * bands can be warped side by side (the photo worker's helpers).
 */
export function warpRgbRows(photo: RgbImage, toPhoto: Mat3, field: Field | null, fieldScale: number, w: number, r0: number, r1: number): Warp {
  const rgb = new Uint8Array(w * (r1 - r0) * 3), valid = new Uint8Array(w * (r1 - r0));
  const src = photo.rgb, sw = photo.w, sh = photo.h;
  let covered = 0;
  for (let y = r0; y < r1; y++) {
    for (let x = 0; x < w; x++) {
      let sx = x, sy = y;
      if (field) { const d = sampleField(field, x * fieldScale, y * fieldScale); sx += d[0] / fieldScale; sy += d[1] / fieldScale; }
      const q = toPhoto[6] * sx + toPhoto[7] * sy + toPhoto[8];
      const px = (toPhoto[0] * sx + toPhoto[1] * sy + toPhoto[2]) / q, py = (toPhoto[3] * sx + toPhoto[4] * sy + toPhoto[5]) / q;
      if (!(q > 0 && px >= 0 && py >= 0 && px < sw - 1 && py < sh - 1)) continue;
      const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i = (y0 * sw + x0) * 3, j = i + sw * 3, o = ((y - r0) * w + x) * 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      rgb[o] = src[i] * w00 + src[i + 3] * w10 + src[j] * w01 + src[j + 3] * w11;
      rgb[o + 1] = src[i + 1] * w00 + src[i + 4] * w10 + src[j + 1] * w01 + src[j + 4] * w11;
      rgb[o + 2] = src[i + 2] * w00 + src[i + 5] * w10 + src[j + 2] * w01 + src[j + 5] * w11;
      valid[(y - r0) * w + x] = 1; covered++;
    }
  }
  return { rgb, valid, covered };
}

/** The whole warp: see warpRgbRows. */
export function warpRgb(photo: RgbImage, toPhoto: Mat3, field: Field | null, fieldScale: number, w: number, h: number): Warp {
  return warpRgbRows(photo, toPhoto, field, fieldScale, w, 0, h);
}
