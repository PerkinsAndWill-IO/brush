// Hit-testing over a scene through a uniform grid. No DOM.
import { Grid } from "./grid";
import { distSqToSegment, pointInRingsEvenOdd } from "./geom";
import type { Scene } from "./scene";
import { boxCorners, layoutText, pointInTextBox, type Measure, type TextLayout } from "./text";

const SEGMENT = 0; // a stroke segment: primXY = x0,y0,x1,y1
const AREA = 1; // a fill or image: primXY = bounding box x0,y0,x1,y1
const TEXT = 2; // a text box: primXY = bounding box

/** Primitives whose bounding box covers more cells than this skip the grid and are always tested. */
const BIG_PRIM_CELLS = 1024;

export interface HitIndex {
  scene: Scene;
  /** Layout per item index, null for non-text items. */
  layouts: (TextLayout | null)[];
  /** item index -> list of item indices sharing its element id (including itself) */
  byElement: Map<number, number[]>;
  grid: Grid;
  primItem: Int32Array;
  primKind: Uint8Array;
  primXY: Float64Array;
  big: number[];
  maxHalfWidth: number;
}

export function buildHitIndex(scene: Scene, measure: Measure): HitIndex {
  const { items } = scene;
  const layouts: (TextLayout | null)[] = new Array(items.length).fill(null);
  const byElement = new Map<number, number[]>();

  let prims = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.el !== null) {
      const list = byElement.get(it.el);
      if (list) list.push(i);
      else byElement.set(it.el, [i]);
    }
    if (it.t === "path") prims += Math.max(0, it.xy.length / 2 - 1) + (it.closed && it.xy.length > 4 ? 1 : 0);
    else if (it.t === "segs") prims += it.xy.length / 4;
    else prims += 1;
  }

  const primItem = new Int32Array(prims);
  const primKind = new Uint8Array(prims);
  const primXY = new Float64Array(prims * 4);
  let p = 0;
  let maxHalfWidth = 0;
  let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < gx0) gx0 = x;
    if (x > gx1) gx1 = x;
    if (y < gy0) gy0 = y;
    if (y > gy1) gy1 = y;
  };
  const addSeg = (item: number, ax: number, ay: number, bx: number, by: number) => {
    primItem[p] = item;
    primKind[p] = SEGMENT;
    primXY.set([ax, ay, bx, by], 4 * p);
    p++;
    grow(ax, ay);
    grow(bx, by);
  };
  const addBox = (item: number, kind: number, x0: number, y0: number, x1: number, y1: number) => {
    primItem[p] = item;
    primKind[p] = kind;
    primXY.set([x0, y0, x1, y1], 4 * p);
    p++;
    grow(x0, y0);
    grow(x1, y1);
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t === "path") {
      maxHalfWidth = Math.max(maxHalfWidth, it.w / 2);
      const n = it.xy.length / 2;
      for (let k = 0; k + 1 < n; k++) addSeg(i, it.xy[2 * k], it.xy[2 * k + 1], it.xy[2 * k + 2], it.xy[2 * k + 3]);
      if (it.closed && n > 2) addSeg(i, it.xy[2 * n - 2], it.xy[2 * n - 1], it.xy[0], it.xy[1]);
    } else if (it.t === "segs") {
      maxHalfWidth = Math.max(maxHalfWidth, it.w / 2);
      for (let k = 0; k < it.xy.length; k += 4) addSeg(i, it.xy[k], it.xy[k + 1], it.xy[k + 2], it.xy[k + 3]);
    } else if (it.t === "fill") {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const ring of it.rings) {
        for (let k = 0; k < ring.length; k += 2) {
          x0 = Math.min(x0, ring[k]); x1 = Math.max(x1, ring[k]);
          y0 = Math.min(y0, ring[k + 1]); y1 = Math.max(y1, ring[k + 1]);
        }
      }
      if (x0 > x1) { // no points: keep a harmless empty primitive so counts stay aligned
        x0 = y0 = x1 = y1 = 0;
      }
      addBox(i, AREA, x0, y0, x1, y1);
    } else if (it.t === "text") {
      const layout = layoutText(it, measure);
      layouts[i] = layout;
      const c = boxCorners(layout);
      addBox(i, TEXT, Math.min(c[0], c[2], c[4], c[6]), Math.min(c[1], c[3], c[5], c[7]), Math.max(c[0], c[2], c[4], c[6]), Math.max(c[1], c[3], c[5], c[7]));
    } else {
      addBox(i, AREA, Math.min(it.min[0], it.max[0]), Math.min(it.min[1], it.max[1]), Math.max(it.min[0], it.max[0]), Math.max(it.min[1], it.max[1]));
    }
  }

  if (!Number.isFinite(gx0)) { // empty scene
    gx0 = scene.min[0]; gy0 = scene.min[1]; gx1 = scene.max[0]; gy1 = scene.max[1];
  }
  const grid = new Grid(gx0, gy0, gx1, gy1, prims);
  const big: number[] = [];
  const bigSet = new Set<number>();
  for (let q = 0; q < prims; q++) {
    if (primKind[q] !== SEGMENT && grid.boxCellCount(primXY[4 * q], primXY[4 * q + 1], primXY[4 * q + 2], primXY[4 * q + 3]) > BIG_PRIM_CELLS) {
      big.push(q);
      bigSet.add(q);
    }
  }
  grid.fill(prims, (q, emit) => {
    const x0 = primXY[4 * q], y0 = primXY[4 * q + 1], x1 = primXY[4 * q + 2], y1 = primXY[4 * q + 3];
    if (primKind[q] === SEGMENT) grid.cellsOfSegment(x0, y0, x1, y1, emit);
    else if (!bigSet.has(q)) grid.cellsOfBox(x0, y0, x1, y1, emit);
  });

  return { scene, layouts, byElement, grid, primItem, primKind, primXY, big, maxHalfWidth };
}

/**
 * Finds the item under (x, y) in world coordinates; `tol` is the pick radius in paper feet.
 * Strokes and text win over fills and images; within a class the latest drawn item wins,
 * and ties go to the nearer one. Returns the item index, or -1.
 */
export function hitTest(index: HitIndex, x: number, y: number, tol: number): number {
  const { scene, grid, primItem, primKind, primXY, layouts } = index;
  let bestItem = -1;
  let bestClass = -1;
  let bestDist = Infinity;

  const consider = (q: number) => {
    const item = primItem[q];
    const kind = primKind[q];
    const it = scene.items[item];
    let cls: number;
    let dist = 0;
    if (kind === SEGMENT) {
      const w = it.t === "path" || it.t === "segs" ? it.w : 0;
      const reach = Math.max(tol, w / 2);
      const d2 = distSqToSegment(x, y, primXY[4 * q], primXY[4 * q + 1], primXY[4 * q + 2], primXY[4 * q + 3]);
      if (d2 > reach * reach) return;
      cls = 1;
      dist = d2;
    } else if (kind === TEXT) {
      if (!pointInTextBox(layouts[item]!, x, y, tol)) return;
      cls = 1;
    } else {
      if (x < primXY[4 * q] || x > primXY[4 * q + 2] || y < primXY[4 * q + 1] || y > primXY[4 * q + 3]) return;
      if (it.t === "fill" && !pointInRingsEvenOdd(x, y, it.rings)) return;
      cls = 0;
    }
    if (cls > bestClass || (cls === bestClass && (item > bestItem || (item === bestItem && dist < bestDist)))) {
      bestClass = cls;
      bestItem = item;
      bestDist = dist;
    }
  };

  const r = Math.max(tol, index.maxHalfWidth);
  grid.query(x - r, y - r, x + r, y + r, consider);
  for (const q of index.big) consider(q);
  return bestItem;
}
