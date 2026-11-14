/**
 * Picking on a `.drawing` page: which item is under a point of the sheet (sheet points, y down)? A uniform grid
 * over every stroke segment and every fill / text / image box, so one query touches a few cells even on sheets
 * with millions of segments. Port of the schema viewer's `hit.ts`, over the editor's parsed items.
 *
 * Strokes are stored as an item number plus an offset into the item's own coordinates (8 bytes per segment): the
 * index never copies the geometry.
 */
import { segmentDistance2 } from '../geometry/vec'
import type { DrawingPage, DrawFill, DrawItem, DrawPath, DrawSegs } from './format'
import { Grid } from './grid'
import { boxCorners, layoutText, pointInTextBox, type Measure, type TextLayout } from './text'

const SEGMENT = 0 // a stroke segment; arg = offset of its x0 in the item's xy, or -1 for the closing segment of a closed path
const AREA = 1 // a fill or image: arg = slot in `boxes`
const TEXT = 2 // a text box: arg = slot in `boxes` (its axis-aligned bounds)

/** Primitives whose bounding box covers more cells than this skip the grid and are always tested. */
const BIG_PRIM_CELLS = 1024

export interface HitIndex {
  page: DrawingPage
  /** Layout per item index, null for non-text items. */
  layouts: (TextLayout | null)[]
  /** Element id -> indices of the items of that element on the page. */
  byElement: Map<string, number[]>
  grid: Grid
  primItem: Int32Array
  primKind: Uint8Array
  primArg: Int32Array
  boxes: Float64Array
  big: number[]
  maxHalfWidth: number
}

/** Even-odd containment over any number of rings (flat x,y arrays, implicitly closed). */
export function pointInRingsEvenOdd(px: number, py: number, rings: readonly ArrayLike<number>[]): boolean {
  let inside = false
  for (const ring of rings) {
    const n = ring.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i]
      const yi = ring[2 * i + 1]
      const xj = ring[2 * j]
      const yj = ring[2 * j + 1]
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Both ends of the segment `arg` of a path or segs item. */
function segmentOf(it: DrawItem, arg: number, out: Float64Array): void {
  if (it.t !== 'path' && it.t !== 'segs') return
  const xy = it.xy
  if (arg < 0) {
    out[0] = xy[xy.length - 2]
    out[1] = xy[xy.length - 1]
    out[2] = xy[0]
    out[3] = xy[1]
  } else {
    out[0] = xy[arg]
    out[1] = xy[arg + 1]
    out[2] = xy[arg + 2]
    out[3] = xy[arg + 3]
  }
}

function fillBounds(f: DrawFill, out: Float64Array, at: number): void {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const ring of f.rings) {
    for (let k = 0; k < ring.length; k += 2) {
      if (ring[k] < x0) x0 = ring[k]
      if (ring[k] > x1) x1 = ring[k]
      if (ring[k + 1] < y0) y0 = ring[k + 1]
      if (ring[k + 1] > y1) y1 = ring[k + 1]
    }
  }
  if (x0 > x1) x0 = y0 = x1 = y1 = 0 // no points: a harmless empty box keeps the slots aligned
  out.set([x0, y0, x1, y1], at)
}

/** Items are indexed in slices of about this many primitives between yields. */
const SLICE_PRIMS = 16_384

/**
 * Builds the index as a generator that yields now and then, so a caller can spread the work over several frames
 * (a 2.5M-segment sheet takes about half a second in one go). `buildHitIndex` runs it to the end.
 */
export function* hitIndexSteps(page: DrawingPage, measure: Measure): Generator<void, HitIndex> {
  const { items } = page
  const layouts: (TextLayout | null)[] = new Array(items.length).fill(null)
  const byElement = new Map<string, number[]>()

  let prims = 0
  let nBoxes = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.el !== null) {
      const list = byElement.get(it.el)
      if (list) list.push(i)
      else byElement.set(it.el, [i])
    }
    if (it.t === 'path') prims += Math.max(0, it.xy.length / 2 - 1) + (it.closed && it.xy.length > 4 ? 1 : 0)
    else if (it.t === 'segs') prims += it.xy.length / 4
    else {
      prims++
      nBoxes++
    }
  }

  const primItem = new Int32Array(prims)
  const primKind = new Uint8Array(prims)
  const primArg = new Int32Array(prims)
  const boxes = new Float64Array(nBoxes * 4)
  let p = 0
  let b = 0
  let maxHalfWidth = 0
  let gx0 = Infinity
  let gy0 = Infinity
  let gx1 = -Infinity
  let gy1 = -Infinity
  const grow = (x: number, y: number) => {
    if (x < gx0) gx0 = x
    if (x > gx1) gx1 = x
    if (y < gy0) gy0 = y
    if (y > gy1) gy1 = y
  }
  const addSeg = (item: number, arg: number, ax: number, ay: number, bx: number, by: number) => {
    primItem[p] = item
    primKind[p] = SEGMENT
    primArg[p] = arg
    p++
    grow(ax, ay)
    grow(bx, by)
  }
  const addBox = (item: number, kind: number) => {
    primItem[p] = item
    primKind[p] = kind
    primArg[p] = b
    p++
    grow(boxes[4 * b], boxes[4 * b + 1])
    grow(boxes[4 * b + 2], boxes[4 * b + 3])
    b++
  }

  let yieldedAt = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (p - yieldedAt > SLICE_PRIMS) {
      yieldedAt = p
      yield
    }
    if (it.t === 'path') {
      maxHalfWidth = Math.max(maxHalfWidth, it.w / 2)
      const xy = it.xy
      const n = xy.length / 2
      for (let k = 0; k + 1 < n; k++) addSeg(i, 2 * k, xy[2 * k], xy[2 * k + 1], xy[2 * k + 2], xy[2 * k + 3])
      if (it.closed && n > 2) addSeg(i, -1, xy[2 * n - 2], xy[2 * n - 1], xy[0], xy[1])
    } else if (it.t === 'segs') {
      maxHalfWidth = Math.max(maxHalfWidth, it.w / 2)
      const xy = it.xy
      for (let k = 0; k + 3 < xy.length; k += 4) addSeg(i, k, xy[k], xy[k + 1], xy[k + 2], xy[k + 3])
    } else if (it.t === 'fill') {
      fillBounds(it, boxes, 4 * b)
      addBox(i, AREA)
    } else if (it.t === 'text') {
      const l = layoutText(it, measure)
      layouts[i] = l
      const c = boxCorners(l)
      boxes.set([Math.min(c[0], c[2], c[4], c[6]), Math.min(c[1], c[3], c[5], c[7]), Math.max(c[0], c[2], c[4], c[6]), Math.max(c[1], c[3], c[5], c[7])], 4 * b)
      addBox(i, TEXT)
    } else {
      boxes.set([it.rect.x, it.rect.y, it.rect.x + it.rect.w, it.rect.y + it.rect.h], 4 * b)
      addBox(i, AREA)
    }
  }
  if (!Number.isFinite(gx0)) {
    gx0 = gy0 = 0
    gx1 = page.sizePt.w
    gy1 = page.sizePt.h
  }

  const grid = new Grid(gx0, gy0, gx1, gy1, prims)
  const big: number[] = []
  const bigSet = new Set<number>()
  for (let q = 0; q < prims; q++) {
    if (primKind[q] === SEGMENT) continue
    const s = 4 * primArg[q]
    if (grid.boxCellCount(boxes[s], boxes[s + 1], boxes[s + 2], boxes[s + 3]) > BIG_PRIM_CELLS) {
      big.push(q)
      bigSet.add(q)
    }
  }
  const s4 = new Float64Array(4)
  yield* grid.fill(prims, (q, emit) => {
    if (primKind[q] === SEGMENT) {
      segmentOf(items[primItem[q]], primArg[q], s4)
      grid.cellsOfSegment(s4[0], s4[1], s4[2], s4[3], emit)
    } else if (!bigSet.has(q)) {
      const s = 4 * primArg[q]
      grid.cellsOfBox(boxes[s], boxes[s + 1], boxes[s + 2], boxes[s + 3], emit)
    }
  })

  return { page, layouts, byElement, grid, primItem, primKind, primArg, boxes, big, maxHalfWidth }
}

export function buildHitIndex(page: DrawingPage, measure: Measure): HitIndex {
  const steps = hitIndexSteps(page, measure)
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value
}

/**
 * The item under (x, y) in sheet points, or -1. `tol` is the pick radius in points. Strokes and text win over fills
 * and images; within a class the latest drawn item wins, and ties go to the nearer segment. `skip` leaves items out
 * (the ones a display filter hides).
 */
export function hitTest(index: HitIndex, x: number, y: number, tol: number, skip?: ((it: DrawItem) => boolean) | null): number {
  const { grid, primItem, primKind, primArg, boxes, layouts } = index
  const items = index.page.items
  let bestItem = -1
  let bestClass = -1
  let bestDist = Infinity
  const consider = (q: number) => {
    const item = primItem[q]
    const kind = primKind[q]
    // Cheap rejections first: this runs for every primitive near the pointer. Whatever is found already beats a
    // fill, and a stroke or text drawn earlier than the best one.
    if (bestClass === 1 && (kind === AREA || item < bestItem)) return
    const it = items[item]
    let cls: number
    let dist = 0
    if (kind === SEGMENT) {
      const stroke = it as DrawPath | DrawSegs
      const xy = stroke.xy
      const arg = primArg[q]
      const ax = arg < 0 ? xy[xy.length - 2] : xy[arg]
      const ay = arg < 0 ? xy[xy.length - 1] : xy[arg + 1]
      const bx = arg < 0 ? xy[0] : xy[arg + 2]
      const by = arg < 0 ? xy[1] : xy[arg + 3]
      const reach = Math.max(tol, stroke.w / 2)
      const d2 = segmentDistance2(x, y, ax, ay, bx, by)
      if (d2 > reach * reach) return
      cls = 1
      dist = d2
    } else if (kind === TEXT) {
      if (!pointInTextBox(layouts[item]!, x, y, tol)) return
      cls = 1
    } else {
      const s = 4 * primArg[q]
      if (x < boxes[s] || x > boxes[s + 2] || y < boxes[s + 1] || y > boxes[s + 3]) return
      if (it.t === 'fill' && !pointInRingsEvenOdd(x, y, it.rings)) return
      cls = 0
    }
    if (skip?.(it)) return
    if (cls > bestClass || (cls === bestClass && (item > bestItem || (item === bestItem && dist < bestDist)))) {
      bestClass = cls
      bestItem = item
      bestDist = dist
    }
  }

  const r = Math.max(tol, index.maxHalfWidth)
  grid.query(x - r, y - r, x + r, y + r, consider)
  for (const q of index.big) consider(q)
  return bestItem
}
