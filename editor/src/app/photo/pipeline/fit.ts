/**
 * The two heavy loops of explainAway (./isolate.ts), on their own so they can run on several threads:
 *  - fitRows: the local paper-and-drawing models, around every grid node, per colour channel photo = A + B * drawing,
 *    fitted robustly;
 *  - explainRows: every pixel against the nine nearest models (how much light ink takes away, its colour, ...).
 * Every node, and every pixel, is worked out on its own, so both split into bands of rows that give exactly the same
 * result side by side as in one go (the photo worker hands the bands to helper workers, see useModelWorkers).
 * PURE: no DOM, no OpenCV.
 */

/** The grid: nodes every `S` px, each fitted on the window of +-`half` px around it, sampled every `stride` px. */
export interface FitGrid { w: number; h: number; S: number; half: number; stride: number; gw: number; gh: number }

/** Rows `y0`.. of the registered photo, its coverage and the blurred drawing (RGB, RGB, mask; `w` wide). */
export interface FitBand { rgb: Uint8Array; valid: Uint8Array; refBlur: Uint8Array; y0: number }

/** Per node (row-major over the rows fitted): intercept and slope per channel, a usable fit, and paper in view. */
export interface FitResult { A: Float32Array; B: Float32Array; ok: Uint8Array; seesPaper: Uint8Array }

/** Slope prior, its weight (as drawing variance), residual scale. */
const B0 = 0.5, V0 = 144, SIGMA = 10;

/** Image rows [y0, y1) the windows of node rows [gy0, gy1) look at. */
export function bandRows(grid: FitGrid, gy0: number, gy1: number): [number, number] {
  return [Math.max(0, gy0 * grid.S - grid.half), Math.min(grid.h, (gy1 - 1) * grid.S + grid.half + 1)];
}

/** Fit node rows [gy0, gy1); `band` must hold at least bandRows(grid, gy0, gy1). */
export function fitRows(grid: FitGrid, band: FitBand, gy0: number, gy1: number): FitResult {
  const { w, h, S, half, stride, gw } = grid, { rgb, valid, refBlur, y0: yOff } = band;
  const G = (gy1 - gy0) * gw;
  const A = new Float32Array(G * 3), B = new Float32Array(G * 3), ok = new Uint8Array(G), seesPaper = new Uint8Array(G);
  const xs = new Float32Array(3072), ys = new Float32Array(3072), hist = new Int32Array(512), idx = new Int32Array(1024);
  for (let gy = gy0; gy < gy1; gy++) for (let gx = 0; gx < gw; gx++) {
    const cx = gx * S, cy = gy * S, g = (gy - gy0) * gw + gx;
    // the window's first 1024 covered pixels (in row order, every `stride`th)
    let n = 0;
    for (let y = Math.max(0, cy - half), y1 = Math.min(h - 1, cy + half), x1 = Math.min(w - 1, cx + half); y <= y1 && n < 1024; y += stride) for (let x = Math.max(0, cx - half); x <= x1 && n < 1024; x += stride) { const i = (y - yOff) * w + x; if (valid[i]) idx[n++] = i; }
    if (n < 40) continue;
    let blank = 0;
    for (let k = 0; k < n; k++) if (Math.min(refBlur[idx[k] * 3], refBlur[idx[k] * 3 + 1], refBlur[idx[k] * 3 + 2]) >= 235) blank++;
    seesPaper[g] = blank >= n * 0.1 ? 1 : 0; // some undrawn paper in view: the paper colour is observed, not extrapolated
    // The three channels are fitted together: a pixel counts as paper in all of them or in none. Fitted one
    // by one, a window half on yellow trace and half on a grey pen would take red and green from the trace and
    // blue from the pen, inventing a paper that is not there.
    for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) { xs[c * 1024 + k] = refBlur[idx[k] * 3 + c]; ys[c * 1024 + k] = rgb[idx[k] * 3 + c]; }
    // start: prior slope, and the colour of the pixels around the 70th percentile of brightness
    // (ink only ever darkens, so lean bright)
    hist.fill(0);
    const lumRes = (k: number): number => 0.30 * (ys[k] - B0 * xs[k]) + 0.59 * (ys[1024 + k] - B0 * xs[1024 + k]) + 0.11 * (ys[2048 + k] - B0 * xs[2048 + k]);
    for (let k = 0; k < n; k++) hist[Math.max(0, Math.min(511, Math.round(lumRes(k)) + 128))]++;
    let acc = 0, v70 = 0;
    for (let v = 0; v < 512; v++) { acc += hist[v]; if (acc >= n * 0.7) { v70 = v - 128; break; } }
    const fa = [0, 0, 0], fb = [B0, B0, B0];
    let cnt = 0;
    for (let k = 0; k < n; k++) if (Math.abs(lumRes(k) - v70) <= 8) { for (let c = 0; c < 3; c++) fa[c] += ys[c * 1024 + k] - B0 * xs[c * 1024 + k]; cnt++; }
    for (let c = 0; c < 3; c++) fa[c] = cnt ? fa[c] / cnt : v70;
    for (let it = 0; it < 4; it++) { // robust re-fit: pixels far from the model (ink, objects) lose their say
      // one pass per round: each pixel's weight (from the previous round's model) and its share of the three
      // channels' weighted sums. The weight is rounded to float32 as it always was (it used to be stored).
      const a0 = fa[0], a1 = fa[1], a2 = fa[2], b0 = fb[0], b1 = fb[1], b2 = fb[2];
      let sw = 0, sx0 = 0, sy0 = 0, sxx0 = 0, sxy0 = 0, sx1 = 0, sy1 = 0, sxx1 = 0, sxy1 = 0, sx2 = 0, sy2 = 0, sxx2 = 0, sxy2 = 0;
      for (let k = 0; k < n; k++) {
        const x0 = xs[k], y0 = ys[k], x1 = xs[1024 + k], y1 = ys[1024 + k], x2 = xs[2048 + k], y2 = ys[2048 + k];
        const r0 = (y0 - a0 - b0 * x0) / SIGMA, r1 = (y1 - a1 - b1 * x1) / SIGMA, r2c = (y2 - a2 - b2 * x2) / SIGMA;
        let r2 = 0;
        r2 += r0 * r0; r2 += r1 * r1; r2 += r2c * r2c;
        const wt = Math.fround(1 / (1 + (r2 * r2) / 9));
        sw += wt;
        sx0 += wt * x0; sy0 += wt * y0; sxx0 += wt * x0 * x0; sxy0 += wt * x0 * y0;
        sx1 += wt * x1; sy1 += wt * y1; sxx1 += wt * x1 * x1; sxy1 += wt * x1 * y1;
        sx2 += wt * x2; sy2 += wt * y2; sxx2 += wt * x2 * x2; sxy2 += wt * x2 * y2;
      }
      if (sw < 1e-6) continue;
      const lam = sw * V0;
      fb[0] = Math.max(0, Math.min(1.3, (sxy0 - (sx0 * sy0) / sw + lam * B0) / (sxx0 - (sx0 * sx0) / sw + lam))); fa[0] = (sy0 - fb[0] * sx0) / sw;
      fb[1] = Math.max(0, Math.min(1.3, (sxy1 - (sx1 * sy1) / sw + lam * B0) / (sxx1 - (sx1 * sx1) / sw + lam))); fa[1] = (sy1 - fb[1] * sx1) / sw;
      fb[2] = Math.max(0, Math.min(1.3, (sxy2 - (sx2 * sy2) / sw + lam * B0) / (sxx2 - (sx2 * sx2) / sw + lam))); fa[2] = (sy2 - fb[2] * sx2) / sw;
    }
    for (let c = 0; c < 3; c++) { A[g * 3 + c] = fa[c]; B[g * 3 + c] = fb[c]; }
    ok[g] = 1;
  }
  return { A, B, ok, seesPaper };
}

/** The fitted models (gaps filled) and the grid they are on; `edgeNode` marks nodes where two kinds of paper meet. */
export interface ExplainParams { w: number; h: number; S: number; gw: number; gh: number; A: Float32Array; B: Float32Array; edgeNode: Uint8Array | null }

/** Rows [y0, y1) of the registered photo, its coverage and the darkest the drawing could be there (RGB, mask, RGB). */
export interface ExplainBand { rgb: Uint8Array; valid: Uint8Array; refLo: Uint8Array; y0: number; y1: number }

/** Per pixel of the rows explained; see explainAway. */
export interface Explained { absorb: Uint8Array; inkRgb: Uint8Array; clean: Uint8Array; flat: Uint8Array; foreign: Uint8Array; edgeZone: Uint8Array | null }

/**
 * Per pixel: of the nine nearest models, take the one that explains the pixel best. Near the edge of a sheet of
 * trace the nearest model may describe the other side; one of its neighbours will describe this one.
 */
export function explainRows(params: ExplainParams, band: ExplainBand): Explained {
  const { w, S, gw, gh, A, B, edgeNode } = params, { rgb, valid, refLo, y0, y1 } = band, N = w * Math.max(0, y1 - y0);
  const absorb = new Uint8Array(N), inkRgb = new Uint8Array(N * 3), clean = new Uint8Array(N * 3).fill(255), flat = new Uint8Array(N).fill(255), foreign = new Uint8Array(N);
  const edgeZone = edgeNode ? new Uint8Array(N) : null;
  for (let y = y0; y < y1; y++) {
    const iy = Math.max(1, Math.min(gh - 2, Math.round(y / S)));
    for (let x = 0; x < w; x++) {
      const p = (y - y0) * w + x; if (!valid[p]) continue;
      const ix = Math.max(1, Math.min(gw - 2, Math.round(x / S))), g0 = iy * gw + ix;
      if (edgeZone && edgeNode) edgeZone[p] = edgeNode[g0];
      const pr = rgb[p * 3], pg = rgb[p * 3 + 1], pb = rgb[p * 3 + 2], lr = refLo[p * 3], lg = refLo[p * 3 + 1], lb = refLo[p * 3 + 2];
      let best = -1, bq = 0, brighter = 0;
      for (let k = 0; k < 9; k++) {
        const q = (g0 + (k % 3) - 1 + (((k / 3) | 0) - 1) * gw) * 3;
        const tr = pr / Math.max(12, A[q] + B[q] * lr), tg = pg / Math.max(12, A[q + 1] + B[q + 1] * lg), tb = pb / Math.max(12, A[q + 2] + B[q + 2] * lb);
        const m = Math.min(1, tr, tg, tb);
        if (m > best) { best = m; bq = q; }
        if (Math.max(tr, tg, tb) > 1.15 && m < 0.92) brighter++; // brighter in one channel, darker in another
      }
      const er = Math.max(12, A[bq] + B[bq] * lr), eg = Math.max(12, A[bq + 1] + B[bq + 1] * lg), eb = Math.max(12, A[bq + 2] + B[bq + 2] * lb); // expected colour
      const paper = Math.max(12, 0.30 * (A[bq] + 255 * B[bq]) + 0.59 * (A[bq + 1] + 255 * B[bq + 1]) + 0.11 * (A[bq + 2] + 255 * B[bq + 2]));
      flat[p] = Math.min(255, (255 * (0.30 * pr + 0.59 * pg + 0.11 * pb)) / paper);
      const a = 1 - best; // share of the pixel covered by ink
      // Ink can only take light away. Something clearly brighter than the paper allows in one channel while
      // darker in another (a grey pen barrel on yellow trace, a white label) is an object lying on the sheet.
      // Ask the majority of the nearby models: a model fitted half on the object itself would excuse it.
      if (brighter >= 5) { foreign[p] = a > 0.06 ? 1 : 2; if (a > 0.06) continue; } // 1: not ink; 2: only counts as "solid object" evidence
      else if (a > 0.1 && Math.max(pr / er, pg / eg, pb / eb) > 1.15) { foreign[p] = 1; continue; }
      absorb[p] = a * 255;
      if (a > 0.06) {
        const k = 255 / (paper * a); // un-mix, and take the lighting level out
        const r = Math.max(0, Math.min(255, (pr - best * er) * k)), g = Math.max(0, Math.min(255, (pg - best * eg) * k)), b = Math.max(0, Math.min(255, (pb - best * eb) * k));
        inkRgb[p * 3] = r; inkRgb[p * 3 + 1] = g; inkRgb[p * 3 + 2] = b;
        clean[p * 3] = 255 * best + a * r; clean[p * 3 + 1] = 255 * best + a * g; clean[p * 3 + 2] = 255 * best + a * b;
      }
    }
  }
  return { absorb, inkRgb, clean, flat, foreign, edgeZone };
}

/** Both loops over a whole image, maybe on several threads. */
export interface ModelWorkers {
  fit(grid: FitGrid, rgb: Uint8Array, valid: Uint8Array, refBlur: Uint8Array): Promise<FitResult>;
  explain(params: ExplainParams, rgb: Uint8Array, valid: Uint8Array, refLo: Uint8Array): Promise<Explained>;
}

let workers: ModelWorkers | null = null;

/** Hand in helpers that run the loops in parallel (the photo worker does); null runs them on this thread. */
export function useModelWorkers(w: ModelWorkers | null): void {
  workers = w;
}

export function fitModels(grid: FitGrid, rgb: Uint8Array, valid: Uint8Array, refBlur: Uint8Array): Promise<FitResult> {
  return workers ? workers.fit(grid, rgb, valid, refBlur) : Promise.resolve(fitRows(grid, { rgb, valid, refBlur, y0: 0 }, 0, grid.gh));
}

export function explainPixels(params: ExplainParams, rgb: Uint8Array, valid: Uint8Array, refLo: Uint8Array): Promise<Explained> {
  return workers ? workers.explain(params, rgb, valid, refLo) : Promise.resolve(explainRows(params, { rgb, valid, refLo, y0: 0, y1: params.h }));
}
