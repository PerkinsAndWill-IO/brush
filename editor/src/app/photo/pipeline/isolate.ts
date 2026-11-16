// Stage 2: separate the hand markup from the drawing and the paper.
//
// The registered photo is compared with what the PDF says should be there. Around every grid node a small
// robust model is fitted per colour channel:   photo = A + B * drawing
// A + 255*B is the local paper colour (white print, yellow trace, a shadow...), B is how strongly the drawing
// shows through. Whatever is clearly darker than that prediction in some channel is ink. This copes with
// coloured drawings, tinted trace, trace covering only part of the sheet, and uneven light.
//
// The colour of the ink is then recovered by un-mixing (photo = (1-a) * paper + a * ink), so a black pen on
// yellow trace comes out black and a red marker red, whatever the paper underneath.
import { loadCv, type Cv } from "./cv";
import { blurRaw, type Log } from "./raster";
import { explainPixels, fitModels } from "./fit";

interface PaperKind { pr: number; pb: number; medLum: number }

/** The ink of one pen: where it is and what colour it has. */
export interface InkLayer {
  /** "black", or the colour family ("red", "blue2", ...). */
  name: string
  /** OpenCV hue 0..179, -1 for black. */
  hue: number
  mask: Uint8Array
  area: number
  color: [number, number, number]
}

export interface IsolateOptions {
  /** Sheet pixels per ~1.5 photo pixels. */
  scale?: number
  ink?: 'both' | 'color' | 'dark'
  colorThresh?: number
  darkThresh?: number
  minArea?: number
  maxStroke?: number
  tolerance?: number
  keepTraceTint?: boolean
  log?: Log
}

/** Run a morphological operation on a JS-side 8-bit image (1 or 3 channels) and copy the result out of WASM memory. */
function morph(cv: Cv, data: Uint8Array, w: number, h: number, op: number, size: number, channels = 1): Uint8Array {
  const m = new cv.Mat(h, w, channels === 3 ? cv.CV_8UC3 : cv.CV_8UC1), out = new cv.Mat();
  m.data.set(data);
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(size, size));
  cv.morphologyEx(m, out, op, k);
  const res = Uint8Array.from(out.data as Uint8Array);
  m.delete(); out.delete(); k.delete();
  return res;
}

/** The k-th smallest of a[0..n) (what a[k] would be after sorting), by quickselect; reorders a[0..n). */
function kthSmallest(a: Float32Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}

function hueOf(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), c = mx - Math.min(r, g, b);
  if (c <= 0) return 0;
  let hh = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  if (hh < 0) hh += 6;
  return Math.min(179, Math.round(hh * 30));
}
const hueDist = (a: number, b: number): number => Math.min(Math.abs(a - b), 180 - Math.abs(a - b));

/**
 * Explain the photo with the drawing and report what is left over.
 * @param rgb registered photo, @param valid coverage mask, @param refRgb rendered drawing (same size)
 * @param scale sheet pixels per ~1.5 photo pixels (1 = the resolution the constants were tuned at)
 * @param tol how many pixels of misregistration to forgive
 * @returns per pixel: absorb (0-255, how much light the unexplained ink takes away), inkRgb (its colour),
 *          clean (ink on white), flat (photo with only the lighting removed);
 *          plus traceHue (tint of the paper, -1 if white) and edgeZone (near the edge of a sheet of trace)
 */
export async function explainAway(cv: Cv, rgb: Uint8Array, valid: Uint8Array, refRgb: Uint8Array, w: number, h: number, { scale = 1, tol = Math.max(1, Math.round(4 * scale)) }: { scale?: number; tol?: number } = {}) {
  const refBlur = await blurRaw(cv, refRgb, w, h, 3, Math.max(0.5, 1.2 * scale)); // roughly the photo's sharpness

  // --- fit the local models
  const S = Math.max(8, Math.round(24 * scale)), half = Math.round(1.5 * S);
  const gw = Math.ceil(w / S) + 1, gh = Math.ceil(h / S) + 1, G = gw * gh;
  const stride = Math.max(1, Math.floor((2 * half + 1) / 24));
  // the models are fitted on the helper workers (when there are any) while this thread erodes the drawing
  const fitted = fitModels({ w, h, S, half, stride, gw, gh }, rgb, valid, refBlur);
  fitted.catch(() => {}); // awaited just below
  const refLo = morph(cv, refBlur, w, h, cv.MORPH_ERODE, 2 * tol + 1, 3); // darkest the drawing could be within tol
  const { A, B, ok, seesPaper } = await fitted;
  if (!ok.some((v) => v)) throw new Error("the registered photo does not cover any of the sheet");

  // A window that sits entirely inside a marker fill, or on an object lying on the sheet, would "learn" that
  // as paper. Find the kinds of paper that really are there (each covers a good share of the sheet: white
  // print, tinted trace...) and discard models whose paper colour is none of them, or far darker than its kind.
  const kindOf = new Int8Array(G).fill(-1); // -1: no usable model / unknown
  let kindList: PaperKind[];
  {
    const cr = new Float32Array(G), cb = new Float32Array(G), lum = new Float32Array(G), taken = new Uint8Array(G);
    let nSee = 0;
    for (let g = 0; g < G; g++) if (ok[g]) {
      const r = Math.max(1, A[g * 3] + 255 * B[g * 3]), gr = Math.max(1, A[g * 3 + 1] + 255 * B[g * 3 + 1]), b = Math.max(1, A[g * 3 + 2] + 255 * B[g * 3 + 2]);
      cr[g] = r / (r + gr + b); cb[g] = b / (r + gr + b); lum[g] = 0.30 * r + 0.59 * gr + 0.11 * b;
      if (seesPaper[g]) nSee++;
    }
    const kinds: PaperKind[] = [];
    for (let t = 0; t < 4 && nSee; t++) {
      const h2 = new Int32Array(100 * 100);
      for (let g = 0; g < G; g++) if (ok[g] && seesPaper[g] && !taken[g]) h2[Math.min(99, (cr[g] * 100) | 0) * 100 + Math.min(99, (cb[g] * 100) | 0)]++;
      let bi = 0, bv = -1;
      for (let i = 1; i < 99; i++) for (let j = 1; j < 99; j++) { let v = 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) v += h2[(i + di) * 100 + j + dj]; if (v > bv) { bv = v; bi = i * 100 + j; } }
      const pr = (((bi / 100) | 0) + 0.5) / 100, pb = ((bi % 100) + 0.5) / 100;
      const members: number[] = [];
      for (let g = 0; g < G; g++) if (ok[g] && seesPaper[g] && !taken[g] && Math.hypot(cr[g] - pr, cb[g] - pb) < 0.035) members.push(g);
      if (members.length < nSee * 0.04) break;
      for (const g of members) taken[g] = 1;
      const ls = members.map((g) => lum[g]).sort((a, b) => a - b);
      kinds.push({ pr, pb, medLum: ls[ls.length >> 1] });
    }
    if (kinds.length) for (let g = 0; g < G; g++) if (ok[g] && seesPaper[g]) {
      let bd = 9, bk: PaperKind = kinds[0];
      for (const k of kinds) { const d = Math.hypot(cr[g] - k.pr, cb[g] - k.pb); if (d < bd) { bd = d; bk = k; } }
      if (bd > 0.05 || lum[g] < 0.45 * bk.medLum) ok[g] = 0; else kindOf[g] = kinds.indexOf(bk);
    }
    // Paper cannot be much darker than the same kind of paper around it: that is a dark object (a mouse, a
    // pen cap) whose colour balance happens to match, or a hard shadow. Soft, gradual shading passes.
    if (kinds.length) {
      const dark: number[] = [], buf = new Float32Array(17 * 17);
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const g = y * gw + x; if (kindOf[g] < 0) continue;
        let n = 0;
        for (let j = -16; j <= 16; j += 2) for (let i = -16; i <= 16; i += 2) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && kindOf[yy * gw + xx] === kindOf[g]) buf[n++] = lum[yy * gw + xx]; }
        if (lum[g] < 0.7 * kthSmallest(buf, n, Math.floor(n * 0.75))) dark.push(g);
      }
      for (const g of dark) { ok[g] = 0; kindOf[g] = -1; }
    }
    // A small island of one kind of paper inside another is only believable if it is brighter than its
    // surroundings in every channel (white print showing beside tinted trace). A grey pen barrel lying on
    // yellow trace also looks like "white paper", but it is darker in red and green: that is an object.
    if (kinds.length > 1) {
      const region = new Int32Array(G).fill(-1), sizes: number[] = [];
      for (let g0 = 0; g0 < G; g0++) {
        if (kindOf[g0] < 0 || region[g0] >= 0) continue;
        const id = sizes.length, stack = [g0];
        let n = 0;
        region[g0] = id;
        while (stack.length) {
          const g = stack.pop()!, x = g % gw, y = (g - x) / gw; n++;
          for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue; const q = yy * gw + xx; if (region[q] < 0 && kindOf[q] === kindOf[g0]) { region[q] = id; stack.push(q); } }
        }
        sizes.push(n);
      }
      const P = (g: number, c: number): number => A[g * 3 + c] + 255 * B[g * 3 + c];
      const reject: number[] = [];
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const g = y * gw + x;
        if (kindOf[g] < 0 || sizes[region[g]] >= G * 0.01) continue;
        const votes = new Int32Array(kinds.length), around = kinds.map((): number[] => []);
        for (let j = -8; j <= 8; j += 2) for (let i = -8; i <= 8; i += 2) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < gw && yy < gh) { const k = kindOf[yy * gw + xx]; if (k >= 0) { votes[k]++; around[k].push(yy * gw + xx); } } }
        let major = 0;
        for (let k = 1; k < votes.length; k++) if (votes[k] > votes[major]) major = k;
        if (major === kindOf[g]) continue;
        for (let c = 0; c < 3; c++) {
          const v = around[major].map((q) => P(q, c)).sort((p, q) => p - q);
          if (P(g, c) < 0.97 * v[v.length >> 1]) { reject.push(g); break; }
        }
      }
      for (const g of reject) { ok[g] = 0; kindOf[g] = -1; }
    }
    // Where the window is all coloured fill, the paper colour is an extrapolation and cannot define a kind.
    // Judge such a model, leniently, against the kinds of paper found around it.
    if (kinds.length) {
      const drop: number[] = [];
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const g = y * gw + x;
        if (!ok[g] || seesPaper[g]) continue;
        const near = new Set<number>();
        for (let j = -8; j <= 8; j += 2) for (let i = -8; i <= 8; i += 2) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && kindOf[yy * gw + xx] >= 0) near.add(kindOf[yy * gw + xx]); }
        const cand = near.size ? [...near].map((k) => kinds[k]) : kinds;
        let bd = 9, bk: PaperKind = cand[0];
        for (const k of cand) { const d = Math.hypot(cr[g] - k.pr, cb[g] - k.pb); if (d < bd) { bd = d; bk = k; } }
        if (bd > 0.09 || lum[g] < 0.45 * bk.medLum) drop.push(g);
      }
      for (const g of drop) ok[g] = 0;
    }
    if (!ok.some((v) => v)) throw new Error("could not identify the paper in the photo");
    kindList = kinds;
  }

  // the tint of the paper itself (e.g. yellow trace)
  let traceHue = -1;
  {
    const tint = new Float64Array(180);
    let tinted = 0, known = 0;
    for (let g = 0; g < G; g++) {
      if (kindOf[g] < 0) continue;
      known++;
      const r = A[g * 3] + 255 * B[g * 3], gr = A[g * 3 + 1] + 255 * B[g * 3 + 1], b = A[g * 3 + 2] + 255 * B[g * 3 + 2];
      const mx = Math.max(r, gr, b);
      if (mx < 30 || (mx - Math.min(r, gr, b)) / mx < 0.1) continue;
      tint[hueOf(r, gr, b)]++; tinted++;
    }
    if (tinted > known * 0.05) { let bestV = 0; for (let a = 0; a < 180; a++) { let v = 0; for (let k = -6; k <= 6; k++) v += tint[(a + k + 180) % 180]; if (v > bestV) { bestV = v; traceHue = a; } } }
  }

  // where two kinds of paper meet (the edge of the trace sheet) there are shadows, creases and torn fibres
  const edgeNode = new Uint8Array(G);
  let anyEdge = false;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const near = new Set<number>();
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && kindOf[yy * gw + xx] >= 0) near.add(kindOf[yy * gw + xx]); }
    let differ = false;
    for (const a of near) for (const b of near) if (a < b && Math.hypot(kindList[a].pr - kindList[b].pr, kindList[a].pb - kindList[b].pb) > 0.07) differ = true;
    if (differ) { edgeNode[y * gw + x] = 1; anyEdge = true; }
  }

  // nodes without a usable model take their neighbours'
  let filled = ok;
  for (let iter = 0; iter < gw + gh && filled.some((v) => !v); iter++) {
    const nf = Uint8Array.from(filled), nA = Float32Array.from(A), nB = Float32Array.from(B);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const g = y * gw + x; if (filled[g]) continue;
      let c = 0; const sa = [0, 0, 0], sb = [0, 0, 0];
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < gw && yy < gh && filled[yy * gw + xx]) { const q = (yy * gw + xx) * 3; for (let k = 0; k < 3; k++) { sa[k] += A[q + k]; sb[k] += B[q + k]; } c++; } }
      if (c) { for (let k = 0; k < 3; k++) { nA[g * 3 + k] = sa[k] / c; nB[g * 3 + k] = sb[k] / c; } nf[g] = 1; }
    }
    A.set(nA); B.set(nB); filled = nf;
  }

  // --- per pixel: of the nine nearest models, take the one that explains the pixel best. Near the edge of a
  // sheet of trace the nearest model may describe the other side; one of its neighbours will describe this one.
  const { absorb, inkRgb, clean, flat, foreign, edgeZone } = await explainPixels({ w, h, S, gw, gh, A, B, edgeNode: anyEdge ? edgeNode : null }, rgb, valid, refLo);
  return { absorb, inkRgb, clean, flat, traceHue, edgeZone, foreign, model: { A, B, S, gw, gh, usable: ok, seesPaper, kindOf, kinds: kindList, refLo } };
}

/**
 * Grow `seed` pixels through `weak` pixels (8-connected) and keep the resulting blobs of at least minArea.
 * Blobs lying mostly within `edgeBand` of the sheet border, or mostly (> zoneFrac) inside `zone`, are dropped.
 */
export function growAndFilter(weak: Uint8Array, seed: Uint8Array, w: number, h: number, minArea: number, edgeBand = 0, zone: Uint8Array | null = null, zoneFrac = 1, level: Uint8Array | null = null): Uint8Array {
  const out = new Uint8Array(w * h), seen = new Uint8Array(w * h);
  let cap = 0;
  for (let i = 0; i < weak.length; i++) cap += weak[i] ? 1 : 0;
  const stack = new Int32Array(cap + 1);
  for (let s = 0; s < seed.length; s++) {
    if (!seed[s] || !weak[s] || seen[s]) continue;
    let top = 0, count = 0;
    stack[top++] = s; seen[s] = 1;
    while (count < top) {
      const p = stack[count++], x = p % w, y = (p - x) / w;
      for (let j = -1; j <= 1; j++) {
        const yy = y + j; if (yy < 0 || yy >= h) continue;
        for (let i = -1; i <= 1; i++) {
          const xx = x + i; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (weak[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
        }
      }
    }
    if (count < minArea) continue;
    if (edgeBand) { // a blob hugging the sheet edge is the table or the paper's edge showing, not markup
      let near = 0;
      for (let k = 0; k < count; k++) { const p = stack[k], x = p % w, y = (p - x) / w; if (x < edgeBand || y < edgeBand || x >= w - edgeBand || y >= h - edgeBand) near++; }
      if (near > count * 0.5) continue;
    }
    if (zone) {
      let inZone = 0;
      for (let k = 0; k < count; k++) if (zone[stack[k]]) inZone++;
      let solid = 0;
      if (level) for (let k = 0; k < count; k++) if (level[stack[k]] > 128) solid++;
      if (inZone > count * zoneFrac && solid < count * 0.15) continue;
    }
    for (let k = 0; k < count; k++) out[stack[k]] = 1;
  }
  return out;
}

/**
 * Find solid things that are not markup (a pen, a mouse, a hand lying on the sheet) and return a zone covering
 * them and their immediate surroundings. Two signs, checked on a coarse grid:
 *  - solid ink more than about twice `thickness` across: thicker than any marker;
 *  - solid stuff more than `thickness` across that includes "foreign" pixels, i.e. ones brighter than the
 *    paper allows, which no ink can be (a grey pen barrel on yellow trace).
 * A scribbled-in marker fill of moderate size shows neither sign and is kept.
 */
function objectZone(cv: Cv, mask: Uint8Array, foreign: Uint8Array, w: number, h: number, thickness: number): Uint8Array | null {
  const f = Math.max(2, Math.round(thickness / 10)), cw = Math.ceil(w / f), ch = Math.ceil(h / f);
  const nInk = new Uint16Array(cw * ch), nFor = new Uint16Array(cw * ch);
  for (let y = 0; y < h; y++) { const row = ((y / f) | 0) * cw; for (let x = 0; x < w; x++) { const i = y * w + x; if (mask[i]) nInk[row + ((x / f) | 0)]++; else if (foreign[i]) nFor[row + ((x / f) | 0)]++; } }
  const cInk = new Uint8Array(cw * ch), cSolid = new Uint8Array(cw * ch), cFor = new Uint8Array(cw * ch);
  for (let i = 0; i < cInk.length; i++) { cInk[i] = nInk[i] >= f * f * 0.7 ? 255 : 0; cSolid[i] = nInk[i] + nFor[i] >= f * f * 0.7 ? 255 : 0; cFor[i] = nFor[i] >= f * f * 0.3 ? 255 : 0; }
  const d = Math.max(3, Math.round(thickness / f)) | 1;
  // Close first: reflections and printed labels split a dark object into bands that are each thin enough.
  // Closing would also make dense hatching look solid, so the area must really be mostly ink (hatching is
  // mostly paper between the lines).
  const big = Math.round(d * 2.1) | 1, coreA = morph(cv, morph(cv, cInk, cw, ch, cv.MORPH_CLOSE, d), cw, ch, cv.MORPH_ERODE, big);
  {
    const W1 = cw + 1, integ = new Int32Array(W1 * (ch + 1));
    for (let y = 0; y < ch; y++) for (let x = 0, run = 0; x < cw; x++) { run += cInk[y * cw + x] ? 1 : 0; integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + run; }
    const r = big >> 1;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (!coreA[y * cw + x]) continue;
      const xa = Math.max(0, x - r), xb = Math.min(cw, x + r + 1), ya = Math.max(0, y - r), yb = Math.min(ch, y + r + 1);
      const inked = integ[yb * W1 + xb] - integ[ya * W1 + xb] - integ[yb * W1 + xa] + integ[ya * W1 + xa];
      if (inked < 0.6 * (xb - xa) * (yb - ya)) coreA[y * cw + x] = 0;
    }
  }
  const coreB = morph(cv, cSolid, cw, ch, cv.MORPH_ERODE, d), nearFor = morph(cv, cFor, cw, ch, cv.MORPH_DILATE, d);
  let any = false;
  for (let i = 0; i < coreA.length; i++) { coreA[i] = coreA[i] || (coreB[i] && nearFor[i]) ? 255 : 0; if (coreA[i]) any = true; }
  if (!any) return null;
  const zoneC = morph(cv, coreA, cw, ch, cv.MORPH_DILATE, (3 * d) | 1);
  const zone = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) { const row = ((y / f) | 0) * cw; for (let x = 0; x < w; x++) zone[y * w + x] = zoneC[row + ((x / f) | 0)]; }
  return zone;
}

const HUE_NAMES: [number, string][] = [[10, "red"], [22, "orange"], [35, "yellow"], [85, "green"], [100, "cyan"], [130, "blue"], [150, "purple"], [170, "magenta"], [181, "red"]];
const hueName = (h: number): string => HUE_NAMES.find(([lim]) => h < lim)![1];

/**
 * @param reg {rgb, valid, w, h, refRgb} registered photo plus the rendered drawing
 * @returns {layers: [{name, color:[r,g,b], mask:Uint8Array}], w, h, clean: Uint8Array rgb (ink on white)}
 */
export async function isolateMarkup(reg: { rgb: Uint8Array; valid: Uint8Array; w: number; h: number; refRgb: Uint8Array }, opts: IsolateOptions = {}): Promise<{ layers: InkLayer[]; w: number; h: number; clean: Uint8Array }> {
  const { rgb, valid, w, h, refRgb } = reg;
  const { scale = 1, ink = "both", colorThresh = 0.2, darkThresh = 0.28, maxStroke = 1.2, tolerance, log = console.log } = opts;
  const N = w * h;
  const minArea = Math.max(8, Math.round((opts.minArea ?? 40) * scale * scale));
  const edgeBand = Math.round(24 * scale);
  const halo = Math.max(2, Math.round(6 * scale));
  const cv = await loadCv();

  const { absorb, inkRgb, clean, traceHue, edgeZone, foreign } = await explainAway(cv, rgb, valid, refRgb, w, h, { scale, tol: tolerance });
  const sat = (i: number): number => Math.max(inkRgb[i * 3], inkRgb[i * 3 + 1], inkRgb[i * 3 + 2]) - Math.min(inkRgb[i * 3], inkRgb[i * 3 + 1], inkRgb[i * 3 + 2]);
  const COLOURED = 100; // ink colour brightness/saturation above which a pen counts as coloured rather than black

  // 1. where is there ink at all? (strong pixels, grown into their soft edges)
  const cStrong = colorThresh * 255, dStrong = darkThresh * 255, weakT = 0.45 * Math.min(cStrong, dStrong) + 4;
  const weak = new Uint8Array(N), seed = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const a = absorb[i];
    if (a <= weakT) continue;
    weak[i] = 1;
    if (a > (sat(i) > COLOURED ? cStrong : dStrong)) seed[i] = 1;
  }
  let mask = growAndFilter(weak, seed, w, h, minArea, edgeBand, edgeZone, 0.4, absorb);

  // 2. trim the blur halo: keep a pixel only if it is at least half as inked as the strongest ink close by,
  //    which puts the outline at the half-way point of the soft edge, where the real edge was
  const level = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (mask[i]) level[i] = absorb[i];
  const peak = morph(cv, level, w, h, cv.MORPH_DILATE, 2 * halo + 1);
  for (let i = 0; i < N; i++) if (mask[i] && absorb[i] * 2 < peak[i]) mask[i] = 0;

  // 3. things lying on the sheet are not markup
  if (maxStroke > 0) {
    const zone = objectZone(cv, mask, foreign, w, h, (Math.max(w, h) * maxStroke) / 100);
    if (zone) {
      let before = 0, after = 0;
      for (let i = 0; i < N; i++) before += mask[i];
      mask = growAndFilter(mask, mask, w, h, 1, 0, zone, 0.5);
      for (let i = 0; i < N; i++) after += mask[i];
      if (after < before) log(`ignoring objects lying on the sheet (solid areas far thicker than a pen stroke): ${before - after} px. Use --max-stroke 0 to keep everything.`);
    }
  }

  // 4. which pen? Decide at the stroke cores, where the ink is solid and its colour reliable, then let each
  //    core's label spread outwards through the rest of the stroke.
  const label = new Int8Array(N).fill(-1); // 0 = black, k + 1 = hue peak k
  const hist = new Float64Array(180);
  const core = new Uint8Array(N);
  let colouredCore = 0;
  for (let i = 0; i < N; i++) if (mask[i] && absorb[i] * 4 >= peak[i] * 3) { core[i] = 1; if (sat(i) > COLOURED) { hist[hueOf(inkRgb[i * 3], inkRgb[i * 3 + 1], inkRgb[i * 3 + 2])]++; colouredCore++; } }
  const sm = new Float64Array(180);
  for (let a = 0; a < 180; a++) for (let k = -8; k <= 8; k++) sm[a] += hist[(a + k + 180) % 180] * Math.exp(-(k * k) / 18);
  const peaks: number[] = [];
  for (let a = 0; a < 180; a++) {
    let isMax = sm[a] > 0;
    for (let k = 1; k <= 12 && isMax; k++) if (sm[(a + k) % 180] > sm[a] || sm[(a - k + 180) % 180] >= sm[a]) isMax = false;
    if (isMax) { let mass = 0; for (let k = -12; k <= 12; k++) mass += hist[(a + k + 180) % 180]; if (mass > Math.max(minArea, colouredCore * 0.01)) peaks.push(a); }
  }
  const nearest = new Int8Array(180).fill(-1);
  for (let a = 0; a < 180; a++) { let bd = 30; peaks.forEach((p, k) => { const d = hueDist(a, p); if (d < bd) { bd = d; nearest[a] = k; } }); }
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (core[i]) {
    label[i] = sat(i) > COLOURED ? nearest[hueOf(inkRgb[i * 3], inkRgb[i * 3 + 1], inkRgb[i * 3 + 2])] + 1 : 0; // a stray hue with no pen of its own counts as black
    queue[qt++] = i;
  }
  while (qh < qt) {
    const p = queue[qh++], x = p % w, y = (p - x) / w, l = label[p];
    for (let j = -1; j <= 1; j++) { const yy = y + j; if (yy < 0 || yy >= h) continue; for (let i = -1; i <= 1; i++) { const xx = x + i; if (xx < 0 || xx >= w) continue; const q = yy * w + xx; if (mask[q] && label[q] < 0) { label[q] = l; queue[qt++] = q; } } }
  }

  {
    const seen = new Uint8Array(N), counts = new Int32Array(peaks.length + 1);
    for (let s0 = 0; s0 < N; s0++) {
      if (!mask[s0] || seen[s0]) continue;
      let top = 0, n = 0;
      queue[top++] = s0; seen[s0] = 1; counts.fill(0);
      while (n < top) {
        const p = queue[n++], x = p % w, y = (p - x) / w;
        if (core[p] && label[p] >= 0) counts[label[p]]++;
        for (let j = -1; j <= 1; j++) { const yy = y + j; if (yy < 0 || yy >= h) continue; for (let i = -1; i <= 1; i++) { const xx = x + i; if (xx < 0 || xx >= w) continue; const q = yy * w + xx; if (mask[q] && !seen[q]) { seen[q] = 1; queue[top++] = q; } } }
      }
      let total = 0, major = 0;
      for (let l = 0; l < counts.length; l++) { total += counts[l]; if (counts[l] > counts[major]) major = l; }
      for (let k = 0; k < top; k++) { const l = label[queue[k]]; if (l < 0 || counts[l] < total * 0.1) label[queue[k]] = major; }
    }
  }

  // 5. one layer per pen
  const layers: InkLayer[] = [];
  for (let l = 0; l <= peaks.length; l++) {
    const isBlack = l === 0, p = isBlack ? -1 : peaks[l - 1];
    if ((isBlack && ink === "color") || (!isBlack && ink === "dark")) continue;
    // "ink" with the trace's own tint is a second layer of trace (a fold, an overlap), not a pen
    if (!isBlack && traceHue >= 0 && !opts.keepTraceTint && hueDist(p, traceHue) <= 12) { log(`ignoring ${hueName(p)} areas: same tint as the trace paper (folds or overlapping sheets)`); continue; }
    const m = new Uint8Array(N);
    let any = false;
    for (let i = 0; i < N; i++) if (label[i] === l) { m[i] = 1; any = true; }
    if (!any) continue;
    const lm = growAndFilter(m, m, w, h, minArea);
    const px: number[] = [];
    let area = 0;
    for (let i = 0; i < N; i++) if (lm[i]) { area++; if (core[i]) px.push(i); }
    if (!area) continue;
    const step = Math.max(1, Math.floor(px.length / 20000));
    const med = (c: number): number => { const a: number[] = []; for (let k = 0; k < px.length; k += step) a.push(inkRgb[px[k] * 3 + c]); a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
    layers.push({ name: isBlack ? "black" : hueName(p), hue: p, mask: lm, area, color: [med(0), med(1), med(2)] });
  }
  // two pens of the same colour family get numbered
  const seenNames: Record<string, number> = {};
  for (const l of layers) { seenNames[l.name] = (seenNames[l.name] ?? 0) + 1; if (seenNames[l.name] > 1) l.name += seenNames[l.name]; }
  log(`ink found: ${layers.map((l) => `${l.name} ${l.area} px`).join(", ") || "none"}`);
  return { layers, w, h, clean };
}
