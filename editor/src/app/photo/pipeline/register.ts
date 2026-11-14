// Stage 1: register the photo to the rendered drawing.
//   a) AKAZE features + RANSAC  -> global homography (photo -> sheet)
//   b) tile-by-tile template matching against the drawing -> better homography,
//      then a smooth residual field that absorbs paper wrinkle / lens distortion
//   c) one resample of the original photo into sheet space
import { loadCv, type Cv, type Mat } from "./cv";
import { rgbToGray, resizeRaw, blurRaw, matMul3, matInv3, applyH, scaleMat, type GrayImage, type Log, type Mat3, type RgbImage } from "./raster";
import { explainAway } from "./isolate";

/** A coarse grid of displacements (px), bilinear in between. */
export interface Field { gw: number; gh: number; x0: number; y0: number; step: number; dx: Float32Array; dy: Float32Array }
interface MeasuredField extends Field { okx: Uint8Array; oky: Uint8Array; why: Record<string, number> }
interface FieldStats { nodes: number; partial: number; total: number; median: number; p95: number }
/** A grey raster in sheet space with its coverage mask. */
interface Warped { data: Uint8Array; valid: Uint8Array }
interface FeatureMatch { H: Mat3; inliers: number; matches: number }

export interface RegistrationReport {
  featureMatches: number
  featureInliers: number
  /** Photo pixels per sheet pixel near the sheet centre. */
  photoPxPerSheetPx?: number
  offsetBeforeRefine?: number
  offsetAfterHomography?: number
  /** Median residual after the wrinkle correction, sheet px. */
  offsetFinal?: number
  offsetFinalP95?: number
  tilesLocked?: number
  tilesTotal?: number
  /** Share of the sheet the photo covers, 0..1. */
  sheetCoverage?: number
  homography?: Mat3
  /** Sheet px per ~1.5 photo px: the resolution the later stages' constants are scaled by. */
  scale: number
}

export interface Registered {
  rgb: Uint8Array
  valid: Uint8Array
  w: number
  h: number
  refGray: Uint8Array
  refRgb: Uint8Array
  report: RegistrationReport
  mapToPhoto: (x: number, y: number) => [number, number]
  field: Field | null
  fieldScale: number
}

const toMat = (cv: Cv, data: Uint8Array, w: number, h: number): Mat => { const m = new cv.Mat(h, w, cv.CV_8UC1); m.data.set(data); return m; };

/** Feature-based homography between two grey images. Returns H (a -> b) in the given pixel frames. */
function featureHomography(cv: Cv, a: GrayImage, b: GrayImage, log: Log): FeatureMatch | null {
  const A = toMat(cv, a.data, a.w, a.h), B = toMat(cv, b.data, b.w, b.h);
  const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
  clahe.apply(A, A); // the drawing is faint through trace; lift local contrast
  let best: FeatureMatch | null = null;
  for (const threshold of [0.001, 0.0003]) {
    const det = new cv.AKAZE();
    det.setThreshold(threshold);
    const kA = new cv.KeyPointVector(), kB = new cv.KeyPointVector(), dA = new cv.Mat(), dB = new cv.Mat(), none = new cv.Mat();
    det.detectAndCompute(A, none, kA, dA);
    det.detectAndCompute(B, none, kB, dB);
    const good: [number, number][] = [];
    if (kA.size() >= 8 && kB.size() >= 8) {
      const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), knn = new cv.DMatchVectorVector();
      bf.knnMatch(dA, dB, knn, 2);
      for (let i = 0; i < knn.size(); i++) {
        const pair = knn.get(i);
        if (pair.size() >= 2) { const m = pair.get(0), n = pair.get(1); if (m.distance < 0.8 * n.distance) good.push([m.queryIdx, m.trainIdx]); }
        pair.delete();
      }
      bf.delete(); knn.delete();
    }
    let H: Mat3 | null = null, inliers = 0;
    if (good.length >= 12) {
      const src = new cv.Mat(good.length, 1, cv.CV_32FC2), dst = new cv.Mat(good.length, 1, cv.CV_32FC2), mask = new cv.Mat();
      good.forEach(([q, t], i) => { const p = kA.get(q).pt, r = kB.get(t).pt; src.data32F[i * 2] = p.x; src.data32F[i * 2 + 1] = p.y; dst.data32F[i * 2] = r.x; dst.data32F[i * 2 + 1] = r.y; });
      const Hm = cv.findHomography(src, dst, cv.RANSAC, 3.0, mask);
      if (!Hm.empty()) { H = Array.from(Hm.data64F); for (let i = 0; i < mask.rows; i++) inliers += mask.data[i] ? 1 : 0; }
      src.delete(); dst.delete(); mask.delete(); Hm.delete();
    }
    log(`features (threshold ${threshold}): photo ${kA.size()}, drawing ${kB.size()}, matches ${good.length}, inliers ${inliers}`);
    kA.delete(); kB.delete(); dA.delete(); dB.delete(); none.delete(); det.delete();
    if (H && (!best || inliers > best.inliers)) best = { H, inliers, matches: good.length };
    if (best && (best as FeatureMatch).inliers >= 40) break;
  }
  A.delete(); B.delete(); clahe.delete();
  return best;
}

/** Bilinear grey warp of the photo into a sheet-space raster. `toPhoto` maps output px -> photo px. */
function warpGray(photo: GrayImage, toPhoto: Mat3, field: Field | null, w: number, h: number): Warped {
  const out = new Uint8Array(w * h), valid = new Uint8Array(w * h);
  const { data, w: pw, h: ph } = photo;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = x, sy = y;
      if (field) { const d = sampleField(field, x, y); sx += d[0]; sy += d[1]; }
      const q = toPhoto[6] * sx + toPhoto[7] * sy + toPhoto[8];
      const px = (toPhoto[0] * sx + toPhoto[1] * sy + toPhoto[2]) / q, py = (toPhoto[3] * sx + toPhoto[4] * sy + toPhoto[5]) / q;
      if (!(px >= 0 && py >= 0 && px < pw - 1 && py < ph - 1)) continue;
      const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i = y0 * pw + x0;
      out[y * w + x] = (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + pw] * (1 - fx) + data[i + pw + 1] * fx) * fy;
      valid[y * w + x] = 1;
    }
  }
  return { data: out, valid };
}

/** Bilinear colour warp of the photo into sheet space. `field` (optional) is in px of a grid `fieldScale` times the output size. */
function warpRgb(photo: RgbImage, toPhoto: Mat3, field: Field | null, fieldScale: number, w: number, h: number): { rgb: Uint8Array; valid: Uint8Array; covered: number } {
  const rgb = new Uint8Array(w * h * 3), valid = new Uint8Array(w * h);
  const src = photo.rgb, sw = photo.w, sh = photo.h;
  let covered = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = x, sy = y;
      if (field) { const d = sampleField(field, x * fieldScale, y * fieldScale); sx += d[0] / fieldScale; sy += d[1] / fieldScale; }
      const q = toPhoto[6] * sx + toPhoto[7] * sy + toPhoto[8];
      const px = (toPhoto[0] * sx + toPhoto[1] * sy + toPhoto[2]) / q, py = (toPhoto[3] * sx + toPhoto[4] * sy + toPhoto[5]) / q;
      if (!(q > 0 && px >= 0 && py >= 0 && px < sw - 1 && py < sh - 1)) continue;
      const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i = (y0 * sw + x0) * 3, j = i + sw * 3, o = (y * w + x) * 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      rgb[o] = src[i] * w00 + src[i + 3] * w10 + src[j] * w01 + src[j + 3] * w11;
      rgb[o + 1] = src[i + 1] * w00 + src[i + 4] * w10 + src[j + 1] * w01 + src[j + 4] * w11;
      rgb[o + 2] = src[i + 2] * w00 + src[i + 5] * w10 + src[j + 2] * w01 + src[j + 5] * w11;
      valid[y * w + x] = 1; covered++;
    }
  }
  return { rgb, valid, covered };
}

/** Shift a sheet-space grey image by a displacement field: out(x) = img(x + d(x)). */
function warpByField(img: Warped, field: Field, w: number, h: number): Warped {
  const out = new Uint8Array(w * h), valid = new Uint8Array(w * h), data = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = sampleField(field, x, y), px = x + d[0], py = y + d[1];
    if (!(px >= 0 && py >= 0 && px < w - 1 && py < h - 1)) continue;
    const x0 = px | 0, y0 = py | 0, fx = px - x0, fy = py - y0, i = y0 * w + x0;
    out[y * w + x] = (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy;
    valid[y * w + x] = img.valid[i];
  }
  return { data: out, valid };
}

/**
 * Grey image for alignment with the markup taken out as far as possible: lighting flattened, and anything
 * the drawing cannot explain (pen, marker) painted over with blank paper.
 */
async function suppressMarkup(cv: Cv, img: { rgb: Uint8Array; valid: Uint8Array }, refRgb: Uint8Array, w: number, h: number, scale: number): Promise<Warped> {
  const { absorb, flat } = await explainAway(cv, img.rgb, img.valid, refRgb, w, h, { scale, tol: Math.max(3, Math.round(6 * scale)) });
  const N = w * h, ink = new cv.Mat(h, w, cv.CV_8UC1), d = ink.data;
  for (let i = 0; i < N; i++) d[i] = absorb[i] > 56 ? 255 : 0;
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  cv.dilate(ink, ink, k);
  const inked = Uint8Array.from(ink.data);
  ink.delete(); k.delete();
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) out[i] = inked[i] ? 255 : flat[i];
  return { data: out, valid: img.valid };
}

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
 * For a grid of tiles, find where each patch of the drawing sits in the warped photo.
 * Returns per-node displacement d such that warped(c + d) matches drawing(c). A patch with linework in
 * both directions pins x and y; one with only horizontal (or only vertical) lines pins just y (or x).
 */
function measureField(cv: Cv, refData: Uint8Array, warped: Warped, w: number, h: number, { step = 64, tile = 96, search = 20, minScore = 0.3 }: { step?: number; tile?: number; search?: number; minScore?: number } = {}): MeasuredField {
  const why = { outside: 0, blank: 0, slides: 0, weak: 0, edge: 0, outlier: 0 };
  const R = toMat(cv, refData, w, h), Wm = toMat(cv, warped.data, w, h);
  const half = tile >> 1, x0 = half + search, y0 = half + search;
  const gw = Math.max(2, Math.floor((w - 2 * x0) / step) + 1), gh = Math.max(2, Math.floor((h - 2 * y0) / step) + 1);
  const dx = new Float32Array(gw * gh), dy = new Float32Array(gw * gh), okx = new Uint8Array(gw * gh), oky = new Uint8Array(gw * gh);
  const res = new cv.Mat(), ref = refData, v = warped.valid, n = 2 * search + 1;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cx = x0 + gx * step, cy = y0 + gy * step, g = gy * gw + gx;
      // the patch itself must be inside the photo (its search margin may hang over the photo's edge)
      if (!(v[(cy - half) * w + cx - half] && v[(cy - half) * w + cx + half - 1] && v[(cy + half - 1) * w + cx - half] && v[(cy + half - 1) * w + cx + half - 1] && v[cy * w + cx])) { why.outside++; continue; }
      // structure tensor of the drawing patch: which directions can it pin?
      let sxx = 0, syy = 0, sxy = 0;
      for (let y = cy - half + 1; y < cy + half - 1; y++) for (let x = cx - half + 1; x < cx + half - 1; x++) {
        const i = y * w + x, gxv = ref[i + 1] - ref[i - 1], gyv = ref[i + w] - ref[i - w];
        sxx += gxv * gxv; syy += gyv * gyv; sxy += gxv * gyv;
      }
      const tr = (sxx + syy) / 2, df = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy), lmin = (tr - df) / (tile * tile), lmax = (tr + df) / (tile * tile);
      if (lmax < 4) { why.blank++; continue; }
      let useX = true, useY = true;
      if (lmin < 1.5 || lmin < 0.06 * lmax) {
        if (Math.abs(sxy) > 0.08 * Math.abs(sxx - syy)) { why.slides++; continue; } // diagonal lines or hatching: unusable
        if (sxx > syy) useY = false; else useX = false;
      }
      const tpl = R.roi(new cv.Rect(cx - half, cy - half, tile, tile));
      const win = Wm.roi(new cv.Rect(cx - half - search, cy - half - search, tile + 2 * search, tile + 2 * search));
      cv.matchTemplate(win, tpl, res, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(res), px = mm.maxLoc.x, py = mm.maxLoc.y;
      win.delete(); tpl.delete();
      if (mm.maxVal < minScore) { why.weak++; continue; }
      if ((useX && !(px > 0 && px < n - 1)) || (useY && !(py > 0 && py < n - 1))) { why.edge++; continue; }
      const f = res.data32F, c = f[py * n + px];
      if (useX) { const l = f[py * n + px - 1], rr = f[py * n + px + 1], den = l + rr - 2 * c; dx[g] = px - search + (den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - rr)) / den)) : 0); okx[g] = 1; }
      if (useY) { const u = f[(py - 1) * n + px], d = f[(py + 1) * n + px], den = u + d - 2 * c; dy[g] = py - search + (den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (u - d)) / den)) : 0); oky[g] = 1; }
    }
  }
  R.delete(); Wm.delete(); res.delete();
  // reject measurements that disagree with their neighbours
  const filter = (val: Float32Array, ok: Uint8Array): Uint8Array => {
    const keep = new Uint8Array(ok);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const g = gy * gw + gx; if (!ok[g]) continue;
      const a: number[] = [];
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const x = gx + i, y = gy + j; if ((i || j) && x >= 0 && y >= 0 && x < gw && y < gh && ok[y * gw + x]) a.push(val[y * gw + x]); }
      if (a.length < 3) continue;
      a.sort((p, q) => p - q);
      if (Math.abs(val[g] - a[a.length >> 1]) > 2.5) { keep[g] = 0; why.outlier++; }
    }
    return keep;
  };
  return { gw, gh, x0, y0, step, dx, dy, okx: filter(dx, okx), oky: filter(dy, oky), why };
}

function fieldStats(f: MeasuredField): FieldStats {
  const mags: number[] = [];
  let partial = 0;
  for (let i = 0; i < f.okx.length; i++) { if (f.okx[i] && f.oky[i]) mags.push(Math.hypot(f.dx[i], f.dy[i])); else if (f.okx[i] || f.oky[i]) partial++; }
  mags.sort((a, b) => a - b);
  return { nodes: mags.length, partial, total: f.okx.length, median: mags.length ? mags[mags.length >> 1] : NaN, p95: mags.length ? mags[Math.floor(mags.length * 0.95)] : NaN };
}

/**
 * Fit a smooth surface through the measured nodes (thin-plate smoothing spline on the grid, solved by
 * conjugate gradients). Unmeasured nodes are interpolated, and extrapolated linearly at the sheet margins.
 * Nodes that disagree with the fitted surface are dropped and the fit repeated.
 */
function completeField(f: MeasuredField, lambda = 0.3): MeasuredField {
  const { gw, gh } = f, n = gw * gh;
  const tmp = new Float64Array(n);
  const solve = (d: Float32Array, ok: Uint8Array): Float64Array => {
    const wt = Float64Array.from(ok);
    if (!wt.some((v) => v)) return new Float64Array(n);
    const applyA = (u: Float64Array, out: Float64Array) => { // out = W u + lambda * (gradient of the bending energy)
      tmp.fill(0);
      for (let y = 0; y < gh; y++) for (let x = 1; x < gw - 1; x++) { const i = y * gw + x, v = u[i - 1] - 2 * u[i] + u[i + 1]; tmp[i - 1] += v; tmp[i] -= 2 * v; tmp[i + 1] += v; }
      for (let y = 1; y < gh - 1; y++) for (let x = 0; x < gw; x++) { const i = y * gw + x, v = u[i - gw] - 2 * u[i] + u[i + gw]; tmp[i - gw] += v; tmp[i] -= 2 * v; tmp[i + gw] += v; }
      for (let y = 0; y < gh - 1; y++) for (let x = 0; x < gw - 1; x++) { const i = y * gw + x, v = 2 * (u[i] - u[i + 1] - u[i + gw] + u[i + gw + 1]); tmp[i] += v; tmp[i + 1] -= v; tmp[i + gw] -= v; tmp[i + gw + 1] += v; }
      for (let i = 0; i < n; i++) out[i] = wt[i] * u[i] + lambda * tmp[i];
    };
    let u = new Float64Array(n);
    for (let round = 0; round < 3; round++) {
      u = new Float64Array(n);
      const r = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
      let mean = 0, c = 0;
      for (let i = 0; i < n; i++) if (wt[i]) { mean += d[i]; c++; }
      u.fill(mean / c); // start from the average shift
      applyA(u, Ap);
      let rr = 0, bb = 1e-12;
      for (let i = 0; i < n; i++) { const b = wt[i] * d[i]; r[i] = b - Ap[i]; p[i] = r[i]; rr += r[i] * r[i]; bb += b * b; }
      for (let it = 0; it < 4 * n && rr > 1e-10 * bb; it++) {
        applyA(p, Ap);
        let pAp = 0;
        for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
        const a = rr / pAp;
        let nrr = 0;
        for (let i = 0; i < n; i++) { u[i] += a * p[i]; r[i] -= a * Ap[i]; nrr += r[i] * r[i]; }
        const beta = nrr / rr; rr = nrr;
        for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
      }
      let dropped = 0;
      for (let i = 0; i < n; i++) if (wt[i] && Math.abs(d[i] - u[i]) > 1.2) { wt[i] = 0; dropped++; }
      if (!dropped || !wt.some((v) => v)) break;
    }
    return u;
  };
  return { ...f, dx: Float32Array.from(solve(f.dx, f.okx)), dy: Float32Array.from(solve(f.dy, f.oky)) };
}

/**
 * @param photo {rgb,w,h}  @param ref {rgb,w,h} rendered drawing at output resolution
 * @returns {rgb, valid, w, h, report} photo resampled into sheet space
 */
export async function registerPhoto(photo: RgbImage, ref: RgbImage, { log = console.log, refine = true }: { log?: Log; refine?: boolean } = {}): Promise<Registered> {
  const cv = await loadCv();
  const refGray = rgbToGray(ref.rgb, ref.w, ref.h);
  // brightest channel rather than luminance: coloured ink nearly vanishes, the drawing's grey linework does not
  const photoGray = new Uint8Array(photo.w * photo.h);
  for (let i = 0, j = 0; i < photoGray.length; i++, j += 3) photoGray[i] = Math.max(photo.rgb[j], photo.rgb[j + 1], photo.rgb[j + 2]);

  // a) global homography from features, at a working size of ~2000 px
  const sp = Math.min(1, 2000 / Math.max(photo.w, photo.h)), sr = Math.min(1, 2000 / Math.max(ref.w, ref.h));
  const pw = Math.round(photo.w * sp), ph = Math.round(photo.h * sp), rw = Math.round(ref.w * sr), rh = Math.round(ref.h * sr);
  const feat = featureHomography(cv,
    { data: await resizeRaw(cv, photoGray, photo.w, photo.h, 1, pw, ph), w: pw, h: ph },
    { data: await resizeRaw(cv, refGray, ref.w, ref.h, 1, rw, rh), w: rw, h: rh }, log);
  if (!feat || feat.inliers < 12) throw new Error(`Could not register the photo to the drawing (only ${feat ? feat.inliers : 0} consistent feature matches). Check that the PDF page is the sheet in the photo.`);
  // lift to full-resolution frames: photo px -> sheet px
  let H = matMul3(scaleMat(ref.w / rw, ref.h / rh), matMul3(feat.H, scaleMat(pw / photo.w, ph / photo.h)));
  const report: RegistrationReport = { featureMatches: feat.matches, featureInliers: feat.inliers, scale: 1 };

  // how many photo pixels land on one sheet pixel near the sheet centre
  const c0 = applyH(matInv3(H), ref.w / 2, ref.h / 2), c1 = applyH(matInv3(H), ref.w / 2 + 1, ref.h / 2);
  report.photoPxPerSheetPx = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);

  // b) refine against the drawing itself at half the output resolution
  let field: Field | null = null;
  const r = Math.min(1, 2700 / Math.max(ref.w, ref.h)), fw = Math.round(ref.w * r), fh = Math.round(ref.h * r);
  const scale = Math.max(0.5, Math.min(3, 1 / (1.5 * report.photoPxPerSheetPx))); // sheet px per ~1.5 photo px
  if (refine) {
    const refSmall = await blurRaw(cv, await resizeRaw(cv, refGray, ref.w, ref.h, 1, fw, fh), fw, fh, 1, 1.0);
    const pg = { data: photoGray, w: photo.w, h: photo.h };
    const toSmall = scaleMat(fw / ref.w, fh / ref.h);
    let locked = true;
    for (let round = 0; round < 2 && locked; round++) {
      // re-fit the homography on tile matches: hundreds of well-spread points instead of clustered features
      const toPhoto = matInv3(matMul3(toSmall, H)); // small sheet px -> photo px
      const f = measureField(cv, refSmall, warpGray(pg, toPhoto, null, fw, fh), fw, fh, { search: round === 0 ? 28 : 16 });
      const st = fieldStats(f);
      log(`homography refit ${round + 1}: ${st.nodes}/${st.total} tiles locked, median offset ${(st.median / r).toFixed(2)} px, p95 ${(st.p95 / r).toFixed(2)} px (sheet px)`);
      if (round === 0) report.offsetBeforeRefine = st.median / r;
      if (st.nodes < 12) { log("too few tiles locked on; keeping the feature-based registration"); locked = false; break; }
      const src = new cv.Mat(st.nodes, 1, cv.CV_32FC2), dst = new cv.Mat(st.nodes, 1, cv.CV_32FC2), mask = new cv.Mat();
      for (let g = 0, k = 0; g < f.okx.length; g++) {
        if (!(f.okx[g] && f.oky[g])) continue;
        const cx = f.x0 + (g % f.gw) * f.step, cy = f.y0 + Math.floor(g / f.gw) * f.step;
        const p = applyH(toPhoto, cx + f.dx[g], cy + f.dy[g]);
        src.data32F[k * 2] = p[0]; src.data32F[k * 2 + 1] = p[1]; dst.data32F[k * 2] = cx / r; dst.data32F[k * 2 + 1] = cy / r; k++;
      }
      const Hm = cv.findHomography(src, dst, cv.RANSAC, 4.0, mask);
      if (!Hm.empty()) H = Array.from(Hm.data64F);
      src.delete(); dst.delete(); mask.delete(); Hm.delete();
    }
    if (locked) {
      // What a homography cannot explain (wrinkle, curl, lens) becomes a smooth residual field, built up over
      // a few passes. These passes look at a copy of the photo with the markup suppressed, so that heavy pen
      // or marker strokes cannot pull the alignment towards themselves.
      const small = warpRgb(photo, matInv3(matMul3(toSmall, H)), null, 1, fw, fh);
      const base = await suppressMarkup(cv, small, await resizeRaw(cv, ref.rgb, ref.w, ref.h, 3, fw, fh), fw, fh, scale * r);
      let check: FieldStats | null = null, best: { check: FieldStats; field: Field | null } | null = null;
      for (let pass = 0; pass < 5; pass++) {
        const m = measureField(cv, refSmall, field ? warpByField(base, field, fw, fh) : base, fw, fh, { search: pass === 0 ? 16 : 12 });
        check = fieldStats(m);
        log(`wrinkle correction ${pass === 0 ? "before" : "pass " + pass}: median offset ${(check.median / r).toFixed(2)} px, p95 ${(check.p95 / r).toFixed(2)} px, ${check.nodes} tiles pinned both ways + ${check.partial} one way, of ${check.total}`);
        if (pass === 0) { report.offsetAfterHomography = check.median / r; log(`  tiles not used: ${JSON.stringify(m.why)}`); }
        if (check.nodes < 12) break;
        // keep whichever state measured best; stop as soon as a pass makes things worse
        if (best && check.median > best.check.median * 0.97) { if (check.median > best.check.median) { field = best.field; check = best.check; } break; }
        best = { check, field: field ? { ...field, dx: Float32Array.from(field.dx), dy: Float32Array.from(field.dy) } : null };
        if (pass === 4 || (pass > 0 && check.median / r < 0.3)) break;
        const inc = completeField(m);
        if (!field) field = inc;
        else for (let g = 0; g < field.dx.length; g++) { field.dx[g] += inc.dx[g]; field.dy[g] += inc.dy[g]; }
      }
      const last = check as FieldStats | null;
      if (last) { report.offsetFinal = last.median / r; report.offsetFinalP95 = last.p95 / r; report.tilesLocked = last.nodes; report.tilesTotal = last.total; }
    }
  }

  // c) resample the colour photo once, straight into sheet space
  const toPhoto = matInv3(H), w = ref.w, h = ref.h;
  const { rgb, valid, covered } = warpRgb(photo, toPhoto, field, r, w, h);
  report.sheetCoverage = covered / (w * h);
  report.homography = H;
  /** sheet px -> photo px, including the wrinkle correction (for diagnostics) */
  const mapToPhoto = (x: number, y: number): [number, number] => {
    let sx = x, sy = y;
    if (field) { const d = sampleField(field, x * r, y * r); sx += d[0] / r; sy += d[1] / r; }
    return applyH(toPhoto, sx, sy);
  };
  report.scale = scale;
  return { rgb, valid, w, h, refGray, refRgb: ref.rgb, report, mapToPhoto, field, fieldScale: r };
}

/** Rough feature-only registration to learn how many dpi (on the sheet) the photo actually resolves. */
/** Result of a quick feature-only registration. */
export interface Probe { /** dpi (on the sheet) the photo resolves where it looks. */ seenDpi: number; inliers: number }

export async function probePhoto(photo: RgbImage, ref: RgbImage, refDpi: number, log: Log = () => {}): Promise<Probe | null> {
  const cv = await loadCv();
  const refGray = rgbToGray(ref.rgb, ref.w, ref.h), photoGray = new Uint8Array(photo.w * photo.h);
  for (let i = 0, j = 0; i < photoGray.length; i++, j += 3) photoGray[i] = Math.max(photo.rgb[j], photo.rgb[j + 1], photo.rgb[j + 2]);
  const sp = Math.min(1, 2000 / Math.max(photo.w, photo.h)), sr = Math.min(1, 2000 / Math.max(ref.w, ref.h));
  const pw = Math.round(photo.w * sp), ph = Math.round(photo.h * sp), rw = Math.round(ref.w * sr), rh = Math.round(ref.h * sr);
  const feat = featureHomography(cv, { data: await resizeRaw(cv, photoGray, photo.w, photo.h, 1, pw, ph), w: pw, h: ph }, { data: await resizeRaw(cv, refGray, ref.w, ref.h, 1, rw, rh), w: rw, h: rh }, log);
  if (!feat || feat.inliers < 12) return null;
  const H = matMul3(scaleMat(ref.w / rw, ref.h / rh), matMul3(feat.H, scaleMat(pw / photo.w, ph / photo.h))), inv = matInv3(H);
  // measure where the photo actually looks: around the sheet position of the photo centre
  const c = applyH(H, photo.w / 2, photo.h / 2);
  const x = Math.max(0, Math.min(ref.w, c[0])), y = Math.max(0, Math.min(ref.h, c[1]));
  const p0 = applyH(inv, x, y), p1 = applyH(inv, x + 1, y), p2 = applyH(inv, x, y + 1);
  return { seenDpi: refDpi * Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * Math.hypot(p2[0] - p0[0], p2[1] - p0[1])), inliers: feat.inliers };
}
