// Stage 1: register the photo to the rendered drawing.
//   a) AKAZE features + RANSAC  -> global homography (photo -> sheet). The print in the photo may be drawn in
//      another style than the app renders the sheet (another export: line weights, fills, colours, text), so
//      features are also matched on line maps of both, and every candidate is checked tile by tile.
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
/** A global homography that passed the tile check. */
interface CoarseMatch extends FeatureMatch { /** Tiles of the drawing that lock onto the photo under H. */ tiles: number; via: string }

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

/** AKAZE keypoints (x, y pairs) and their descriptors, for one detector threshold. */
interface Features { xy: Float32Array; n: number; desc: Mat }

/**
 * A grey image prepared for feature matching. Keypoints and descriptors are computed once per detector threshold
 * and kept: the photo is matched against every candidate sheet and then again for the trace, and the loose pass
 * reuses the strict pass's features. Call `dispose()` to free the descriptors (WASM memory).
 */
class FeatureSide {
  private mat: Mat | null = null;
  private readonly byThreshold = new Map<number, Features>();
  constructor(private readonly cv: Cv, readonly img: GrayImage, private readonly clahe: boolean) {}
  get(threshold: number): Features {
    const known = this.byThreshold.get(threshold);
    if (known) return known;
    const cv = this.cv;
    if (!this.mat) {
      this.mat = toMat(cv, this.img.data, this.img.w, this.img.h);
      if (this.clahe) { const c = new cv.CLAHE(3.0, new cv.Size(8, 8)); c.apply(this.mat, this.mat); c.delete(); } // the drawing is faint through trace; lift local contrast
    }
    const det = new cv.AKAZE();
    det.setThreshold(threshold);
    const kp = new cv.KeyPointVector(), desc = new cv.Mat(), none = new cv.Mat();
    det.detectAndCompute(this.mat, none, kp, desc);
    const n = kp.size(), xy = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { const p = kp.get(i).pt; xy[i * 2] = p.x; xy[i * 2 + 1] = p.y; }
    kp.delete(); none.delete(); det.delete();
    const f = { xy, n, desc };
    this.byThreshold.set(threshold, f);
    return f;
  }
  dispose(): void {
    this.mat?.delete(); this.mat = null;
    for (const f of this.byThreshold.values()) f.desc.delete();
    this.byThreshold.clear();
  }
}

/**
 * Feature-based homographies between two grey images, H (a -> b) in the given pixel frames, the most consistent
 * first. Up to `rounds` per detector threshold: after each RANSAC fit its inliers are set aside and the rest fitted
 * again, because when the two images are drawn differently a wrong but larger consensus (repeated symbols, a
 * regular grid) can hide the right one. The caller checks which one is right.
 */
/**
 * The two nearest descriptors of `b` for every descriptor of `a` (brute force, Hamming): per keypoint of `a`, the
 * best match's index in `b` and both distances (-1: fewer than two). The slowest step of a match on a large sheet,
 * so the loose pass reuses the strict pass's (same features, only the ratio test differs).
 */
interface Knn { train: Int32Array; d1: Float32Array; d2: Float32Array }
function knnMatch(cv: Cv, fA: Features, fB: Features, cache: Map<string, Knn> | undefined, key: string): Knn {
  const known = cache?.get(key);
  if (known) return known;
  const train = new Int32Array(fA.n).fill(-1), d1 = new Float32Array(fA.n), d2 = new Float32Array(fA.n);
  if (fA.n >= 8 && fB.n >= 8) {
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), knn = new cv.DMatchVectorVector();
    bf.knnMatch(fA.desc, fB.desc, knn, 2);
    for (let i = 0; i < knn.size(); i++) {
      const pair = knn.get(i);
      if (pair.size() >= 2) { const m = pair.get(0), n = pair.get(1); train[m.queryIdx] = m.trainIdx; d1[m.queryIdx] = m.distance; d2[m.queryIdx] = n.distance; }
      pair.delete();
    }
    bf.delete(); knn.delete();
  }
  const k = { train, d1, d2 };
  cache?.set(key, k);
  return k;
}

function featureCandidates(cv: Cv, a: FeatureSide, b: FeatureSide, log: Log, { thresholds = [0.001, 0.0003], ratio = 0.8, rounds = 3, enough = 40, label = "features", knnCache }: { thresholds?: number[]; ratio?: number; rounds?: number; enough?: number; label?: string; knnCache?: Map<string, Knn> } = {}): FeatureMatch[] {
  const out: FeatureMatch[] = [];
  for (const threshold of thresholds) {
    const fA = a.get(threshold), fB = b.get(threshold);
    const knn = knnMatch(cv, fA, fB, knnCache, String(threshold));
    const good: [number, number][] = [];
    for (let q = 0; q < fA.n; q++) if (knn.train[q] >= 0 && knn.d1[q] < ratio * knn.d2[q]) good.push([q, knn.train[q]]);
    const pts = good.map(([q, t]) => [fA.xy[q * 2], fA.xy[q * 2 + 1], fB.xy[t * 2], fB.xy[t * 2 + 1]]);
    const found: number[] = [];
    for (let round = 0; round < rounds && pts.length >= 12; round++) {
      const src = new cv.Mat(pts.length, 1, cv.CV_32FC2), dst = new cv.Mat(pts.length, 1, cv.CV_32FC2), mask = new cv.Mat();
      pts.forEach((p, i) => { src.data32F[i * 2] = p[0]; src.data32F[i * 2 + 1] = p[1]; dst.data32F[i * 2] = p[2]; dst.data32F[i * 2 + 1] = p[3]; });
      const Hm = cv.findHomography(src, dst, cv.RANSAC, 3.0, mask);
      let inliers = 0;
      if (!Hm.empty()) {
        for (let i = 0; i < mask.rows; i++) inliers += mask.data[i] ? 1 : 0;
        if (inliers >= 8) out.push({ H: Array.from(Hm.data64F as Float64Array), inliers, matches: good.length });
        for (let i = mask.rows - 1; i >= 0; i--) if (mask.data[i]) pts.splice(i, 1);
      }
      src.delete(); dst.delete(); mask.delete(); Hm.delete();
      found.push(inliers);
      if (inliers < 8) break;
    }
    log(`${label} (threshold ${threshold}): photo ${fA.n}, drawing ${fB.n}, matches ${good.length}, inliers ${found.join(" / ") || 0}`);
    if (out.some((m) => m.inliers >= enough)) break;
  }
  return out.sort((p, q) => q.inliers - p.inliers);
}

/** Long side of the rasters the features are found on. */
const FEATURE_SIDE = 2000;

/** The photo, prepared once for every match against it: its grey version and its features (see FeatureSide). */
interface PhotoPrep { gray: GrayImage; side: FeatureSide }
const photoPreps = new WeakMap<RgbImage, PhotoPrep>();

function prepPhoto(cv: Cv, photo: RgbImage): PhotoPrep {
  let prep = photoPreps.get(photo);
  if (prep) return prep;
  // brightest channel rather than luminance: coloured ink nearly vanishes, the drawing's grey linework does not
  const data = new Uint8Array(photo.w * photo.h);
  for (let i = 0, j = 0; i < data.length; i++, j += 3) data[i] = Math.max(photo.rgb[j], photo.rgb[j + 1], photo.rgb[j + 2]);
  const sp = Math.min(1, FEATURE_SIDE / Math.max(photo.w, photo.h)), pw = Math.round(photo.w * sp), ph = Math.round(photo.h * sp);
  const small: GrayImage = { data: resizeRaw(cv, data, photo.w, photo.h, 1, pw, ph), w: pw, h: ph };
  prep = { gray: { data, w: photo.w, h: photo.h }, side: new FeatureSide(cv, small, true) };
  photoPreps.set(photo, prep);
  return prep;
}

/**
 * Get the photo ready for matching (grey version, features at the first detector threshold) ahead of the first
 * probe. The photo worker runs this while the main thread renders the first candidate sheet.
 */
export async function preparePhoto(photo: RgbImage): Promise<void> {
  const cv = await loadCv();
  prepPhoto(cv, photo).side.get(0.001);
}

/** Free the photo's cached features (WASM memory). The worker drops them with the photo. */
export function releasePhoto(photo: RgbImage): void {
  photoPreps.get(photo)?.side.dispose();
  photoPreps.delete(photo);
}

/** Side of the raster the tile check runs at. */
const CHECK_SIDE = 1400;
const checkSize = (ref: GrayImage) => { const r = Math.min(1, CHECK_SIDE / Math.max(ref.w, ref.h)); return { r, w: Math.round(ref.w * r), h: Math.round(ref.h * r) }; };

/**
 * Does H (photo px -> ref px) put the drawing's linework onto the photo's? The photo is warped into the sheet and
 * tiles of the drawing are matched in a small window: under a wrong H nothing locks, under a right one tiles lock
 * wherever both show linework, even when the two are drawn differently.
 */
function checkHomography(cv: Cv, photo: GrayImage, ref: GrayImage, H: Mat3, refSmall: Uint8Array): { tiles: number; usable: number } {
  const { r, w, h } = checkSize(ref);
  const warped = warpGray(photo, matInv3(matMul3(scaleMat(r, r), H)), null, w, h);
  const f = measureField(cv, refSmall, warped, w, h, { step: 48, tile: 64, search: 10 });
  const st = fieldStats(f);
  return { tiles: st.nodes + (st.partial >> 1), usable: Math.max(0, st.total - f.why.outside - f.why.blank - f.why.slides) };
}

/** Do two homographies (photo -> ref) put the ref's corners within a few px of the same photo points? */
function sameHomography(A: Mat3, B: Mat3, w: number, h: number): boolean {
  const ia = matInv3(A), ib = matInv3(B);
  return [[0, 0], [w, 0], [0, h], [w, h]].every(([x, y]) => { const p = applyH(ia, x, y), q = applyH(ib, x, y); return Math.hypot(p[0] - q[0], p[1] - q[1]) < 4; });
}

/** Fewest tiles that must lock for a global homography to count, and the share of the usable tiles. */
const MIN_TILES = 12, MIN_TILE_SHARE = 0.08;

/** A strict feature match with at least this many inliers needs no second, more sensitive detector pass. */
const ENOUGH_INLIERS = 40;

/**
 * The search for the global homography photo -> ref, in two steps so that a caller comparing many sheets can look
 * at every sheet's first step before paying for the rest:
 *  - `first()`: features at the first detector threshold. When they give a confident match (ENOUGH_INLIERS) its
 *    candidates are checked tile by tile, and if one locks on the search is over (`final`).
 *  - `finish()`: everything else, exactly as one uninterrupted search would go on: the second, more sensitive
 *    threshold, and then the looser ratio test.
 * Run one after the other, the two give the same result as before they were split.
 */
class CoarseSearch {
  best: CoarseMatch | null = null;
  final = false;
  private readonly b: FeatureSide;
  private readonly knnCache = new Map<string, Knn>();
  private readonly tried: Mat3[] = [];
  private refCheck: Uint8Array | null = null;
  private strict: FeatureMatch[] = [];
  /** What finish() still has to do: the second threshold (then loose), or only the loose pass. */
  private next: "strict" | "loose" | null = null;
  constructor(private readonly cv: Cv, private readonly prep: PhotoPrep, private readonly ref: GrayImage, private readonly log: Log) {
    const sr = Math.min(1, FEATURE_SIDE / Math.max(ref.w, ref.h)), rw = Math.round(ref.w * sr), rh = Math.round(ref.h * sr);
    this.b = new FeatureSide(cv, { data: resizeRaw(cv, ref.data, ref.w, ref.h, 1, rw, rh), w: rw, h: rh }, false);
  }
  /** Lift a match on the feature rasters to full-resolution frames: photo px -> ref px. */
  private lift(H: Mat3): Mat3 {
    const { prep, ref, b } = this;
    return matMul3(scaleMat(ref.w / b.img.w, ref.h / b.img.h), matMul3(H, scaleMat(prep.side.img.w / prep.gray.w, prep.side.img.h / prep.gray.h)));
  }
  private consider(ms: FeatureMatch[], via: string): void {
    const { cv, ref } = this;
    for (const m of ms.slice(0, 6)) {
      const H = this.lift(m.H);
      // the same alignment found twice (another threshold or pass): check it once
      if (this.tried.some((T) => sameHomography(T, H, ref.w, ref.h))) continue;
      this.tried.push(H);
      // the drawing as the tile check sees it, made once for all the candidates
      if (!this.refCheck) { const { w, h } = checkSize(ref); this.refCheck = blurRaw(cv, resizeRaw(cv, ref.data, ref.w, ref.h, 1, w, h), w, h, 1, 1.0); }
      const c = checkHomography(cv, this.prep.gray, ref, H, this.refCheck);
      const ok = c.tiles >= MIN_TILES && c.tiles >= MIN_TILE_SHARE * c.usable;
      this.log(`  ${via}: ${m.inliers} inliers, ${c.tiles} of ${c.usable} tiles lock${ok ? "" : " (rejected)"}`);
      if (ok && (!this.best || c.tiles > this.best.tiles)) this.best = { ...m, H, tiles: c.tiles, via };
    }
  }
  private loose(): void {
    // nothing locked on: the print may be drawn differently from the app's sheet. A looser ratio test keeps more of
    // the right matches (and more wrong ones, which the tile check turns down)
    this.consider(featureCandidates(this.cv, this.prep.side, this.b, this.log, { thresholds: [0.001], ratio: 0.9, rounds: 4, label: "loose features", knnCache: this.knnCache }), "loose features");
  }
  first(): void {
    this.strict = featureCandidates(this.cv, this.prep.side, this.b, this.log, { thresholds: [0.001], knnCache: this.knnCache });
    if (!this.strict.some((m) => m.inliers >= ENOUGH_INLIERS)) { this.next = "strict"; return; }
    this.consider(this.strict, "features");
    if (this.best) this.final = true;
    else this.next = "loose";
  }
  finish(): CoarseMatch | null {
    if (this.next === "strict") {
      const more = featureCandidates(this.cv, this.prep.side, this.b, this.log, { thresholds: [0.0003], knnCache: this.knnCache });
      this.consider([...this.strict, ...more].sort((p, q) => q.inliers - p.inliers), "features");
      if (!this.best) this.loose();
    } else if (this.next === "loose") this.loose();
    this.next = null;
    this.final = true;
    return this.best;
  }
  dispose(): void {
    this.b.dispose();
  }
}

/**
 * Global homography photo -> ref (both full-size grey). Candidates come from feature matches; when those are few
 * (the print may be drawn in another style than the app draws the sheet: other line weights, fills, colours,
 * text), a looser match adds more. Each candidate is checked tile by tile, and the one that locks most tiles wins:
 * a handful of right matches is enough, and a large wrong consensus is turned down.
 */
function coarseHomography(cv: Cv, prep: PhotoPrep, ref: GrayImage, log: Log): CoarseMatch | null {
  const search = new CoarseSearch(cv, prep, ref, log);
  try {
    search.first();
    return search.final ? search.best : search.finish();
  } finally {
    search.dispose();
  }
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
 * Where a quick probe (probePhoto) found the sheet in the photo: its homography (photo px -> px of the probe's
 * render, `w` x `h`). The full registration starts from it instead of matching features again.
 */
export interface Seed { H: Mat3; w: number; h: number; inliers: number; matches: number }

/**
 * @param photo {rgb,w,h}  @param ref {rgb,w,h} rendered drawing at output resolution
 * @param seed the probe's match of this photo to this sheet (used with `refine` only; checked by the refit, and
 *        features are matched afresh if it does not hold)
 * @returns {rgb, valid, w, h, report} photo resampled into sheet space
 */
export async function registerPhoto(photo: RgbImage, ref: RgbImage, { log = console.log, refine = true, seed }: { log?: Log; refine?: boolean; seed?: Seed } = {}): Promise<Registered> {
  const cv = await loadCv();
  const refGray = rgbToGray(ref.rgb, ref.w, ref.h);
  const prep = prepPhoto(cv, photo), pg = prep.gray;

  // a) global homography from features, at a working size of ~2000 px, checked tile by tile; or the probe's
  const matchFeatures = async (): Promise<FeatureMatch> => {
    const m = await coarseHomography(cv, prep, { data: refGray, w: ref.w, h: ref.h }, log);
    if (!m) throw new Error("Could not register the photo to the drawing: no alignment puts the drawing's lines onto the photo's. Check that the page is the sheet in the photo.");
    return m;
  };
  const seeded = !!seed && refine;
  let feat: FeatureMatch;
  if (seed && seeded) {
    feat = { H: matMul3(scaleMat(ref.w / seed.w, ref.h / seed.h), seed.H), inliers: seed.inliers, matches: seed.matches };
    log(`starting from the sheet match (${seed.inliers} inliers)`);
  } else feat = await matchFeatures();
  let H = feat.H;
  const report: RegistrationReport = { featureMatches: feat.matches, featureInliers: feat.inliers, scale: 1 };

  // b) refine against the drawing itself at half the output resolution
  let field: Field | null = null;
  const r = Math.min(1, 2700 / Math.max(ref.w, ref.h)), fw = Math.round(ref.w * r), fh = Math.round(ref.h * r);
  const refSmall = refine ? blurRaw(cv, resizeRaw(cv, refGray, ref.w, ref.h, 1, fw, fh), fw, fh, 1, 1.0) : null;
  const toSmall = scaleMat(fw / ref.w, fh / ref.h);
  let locked = false;
  if (refSmall) {
    const refit = (H0: Mat3): { H: Mat3; locked: boolean; before: number } => {
      let H = H0, before = NaN;
      for (let round = 0; round < 2; round++) {
        // re-fit the homography on tile matches: hundreds of well-spread points instead of clustered features
        const toPhoto = matInv3(matMul3(toSmall, H)); // small sheet px -> photo px
        const f = measureField(cv, refSmall, warpGray(pg, toPhoto, null, fw, fh), fw, fh, { search: round === 0 ? 28 : 16 });
        const st = fieldStats(f);
        log(`homography refit ${round + 1}: ${st.nodes}/${st.total} tiles locked, median offset ${(st.median / r).toFixed(2)} px, p95 ${(st.p95 / r).toFixed(2)} px (sheet px)`);
        if (round === 0) before = st.median / r;
        if (st.nodes < 12) return { H, locked: false, before };
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
      return { H, locked: true, before };
    };
    let fit = refit(H);
    if (!fit.locked && seeded) {
      // the probe's coarse match did not hold at this resolution: match features at this one, as without a seed
      log("the sheet match did not hold at full resolution; matching features again");
      feat = await matchFeatures();
      report.featureMatches = feat.matches; report.featureInliers = feat.inliers;
      fit = refit(feat.H);
    }
    report.offsetBeforeRefine = fit.before;
    locked = fit.locked;
    H = fit.H;
    if (!locked) log("too few tiles locked on; keeping the feature-based registration");
  }

  // how many photo pixels land on one sheet pixel near the sheet centre
  const c0 = applyH(matInv3(feat.H), ref.w / 2, ref.h / 2), c1 = applyH(matInv3(feat.H), ref.w / 2 + 1, ref.h / 2);
  report.photoPxPerSheetPx = Math.hypot(c1[0] - c0[0], c1[1] - c0[1]);
  const scale = Math.max(0.5, Math.min(3, 1 / (1.5 * report.photoPxPerSheetPx))); // sheet px per ~1.5 photo px
  if (refSmall && locked) {
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

/** Result of a quick coarse registration (which sheet, and how many dpi on it the photo actually resolves). */
export interface Probe {
  /** dpi (on the sheet) the photo resolves where it looks. */
  seenDpi: number
  /** Consistent feature matches. */
  inliers: number
  /** Tiles of the drawing that lock onto the photo: how well the sheet fits it, whatever style it is drawn in. */
  tiles: number
  /** Feature matches that passed the ratio test. */
  matches: number
  /** The match: photo px -> px of the probe's render (the full registration can start from it, see Seed). */
  H: Mat3
}

function probeOf(feat: CoarseMatch, photo: RgbImage, ref: { w: number; h: number }, refDpi: number): Probe {
  const H = feat.H, inv = matInv3(H);
  // measure where the photo actually looks: around the sheet position of the photo centre
  const c = applyH(H, photo.w / 2, photo.h / 2);
  const x = Math.max(0, Math.min(ref.w, c[0])), y = Math.max(0, Math.min(ref.h, c[1]));
  const p0 = applyH(inv, x, y), p1 = applyH(inv, x + 1, y), p2 = applyH(inv, x, y + 1);
  return { seenDpi: refDpi * Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * Math.hypot(p2[0] - p0[0], p2[1] - p0[1])), inliers: feat.inliers, tiles: feat.tiles, matches: feat.matches, H };
}

/**
 * The quick match of the photo against one sheet, in the two steps of CoarseSearch: `first()` says whether the
 * sheet matched confidently on the first try (`final`); `finish()` completes the search. One after the other they
 * give what probePhoto gives. Call `dispose()` when done with it (WASM memory).
 */
export class SheetProbe {
  private constructor(private readonly search: CoarseSearch, private readonly photo: RgbImage, private readonly ref: { w: number; h: number }, private readonly refDpi: number) {}
  static async start(photo: RgbImage, ref: RgbImage, refDpi: number, log: Log = () => {}): Promise<SheetProbe> {
    const cv = await loadCv();
    const search = new CoarseSearch(cv, prepPhoto(cv, photo), { data: rgbToGray(ref.rgb, ref.w, ref.h), w: ref.w, h: ref.h }, log);
    return new SheetProbe(search, photo, { w: ref.w, h: ref.h }, refDpi);
  }
  first(): { probe: Probe | null; final: boolean } {
    this.search.first();
    return { probe: this.search.final && this.search.best ? probeOf(this.search.best, this.photo, this.ref, this.refDpi) : null, final: this.search.final };
  }
  finish(): Probe | null {
    const best = this.search.final ? this.search.best : this.search.finish();
    return best ? probeOf(best, this.photo, this.ref, this.refDpi) : null;
  }
  dispose(): void {
    this.search.dispose();
  }
}

export async function probePhoto(photo: RgbImage, ref: RgbImage, refDpi: number, log: Log = () => {}): Promise<Probe | null> {
  const p = await SheetProbe.start(photo, ref, refDpi, log);
  try {
    p.first();
    return p.finish();
  } finally {
    p.dispose();
  }
}
