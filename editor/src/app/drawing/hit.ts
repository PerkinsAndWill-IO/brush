/**
 * Hit-testing on `.drawing` pages (docs/tasks/V3-inspect.md), ported from the schema viewer (`schema/src/hit.ts`):
 * every item is split into primitives (stroke segments, fill/image boxes, text boxes) and bucketed in a uniform
 * grid, so finding the element under the pointer touches only a few primitives even on 300k-segment sheets.
 * Works in sheet points (y down). No DOM: text width comes from an injected `measure`.
 */
import type { DrawingPage, DrawItem, DrawText } from '@core/drawing'

const SEGMENT = 0 // primXY = x0,y0,x1,y1
const AREA = 1 // fill or image: primXY = bounding box
const TEXT = 2 // text: primXY = bounding box, exact quad in `textQuads`

/** Boxes covering more cells than this skip the grid and are always tested (title block frames, big fills). */
const BIG_PRIM_CELLS = 1024
const MAX_CELLS_PER_AXIS = 1024

/** Width of `text` in points at `em` points per em. */
export type Measure = (text: string, em: number, bold: boolean) => number

/** Arial cap height in em, and line height (as in the renderer). */
export const CAP_EM = 0.716
export const LINE_EM = 1.2

/** Average Arial glyph width in em: the fallback when no canvas is at hand. */
export const roughMeasure: Measure = (text, em, bold) => text.length * em * (bold ? 0.58 : 0.53)

/** Corners of a text item's box, flat x,y in sheet points (4 corners, in order). Mirrors the renderer's layout. */
export function textQuad(t: DrawText, measure: Measure): Float32Array {
  const em = t.size / CAP_EM
  const paras = t.text.split('\n')
  let width = 0
  let lines = 0
  for (const p of paras) {
    const w = measure(p, em, t.bold)
    if (t.maxWidth !== null && w > t.maxWidth) {
      width = Math.max(width, t.maxWidth)
      lines += Math.ceil(w / t.maxWidth)
    } else {
      width = Math.max(width, w)
      lines += 1
    }
  }
  const height = lines * em * LINE_EM
  const fx = t.anchor[0] === 'l' ? 0 : t.anchor[0] === 'r' ? 1 : 0.5
  const fy = t.anchor[1] === 't' ? 0 : t.anchor[1] === 'b' ? 1 : 0.5
  const x0 = -fx * width, x1 = x0 + width
  const y0 = -fy * height, y1 = y0 + height
  const { x: dx, y: dy } = t.dir
  const nx = -dy, ny = dx // local +y (down the lines) in sheet space
  const at = (lx: number, ly: number) => [t.at.x + dx * lx + nx * ly, t.at.y + dy * lx + ny * ly]
  return new Float32Array([...at(x0, y0), ...at(x1, y0), ...at(x1, y1), ...at(x0, y1)])
}

function pointInQuad(q: Float32Array, x: number, y: number, tol: number): boolean {
  // convex quad: inside when on the same side of all four edges (with tolerance along the edge normal)
  let sign = 0
  for (let k = 0; k < 4; k++) {
    const ax = q[2 * k], ay = q[2 * k + 1]
    const bx = q[(2 * k + 2) % 8], by = q[(2 * k + 3) % 8]
    const ex = bx - ax, ey = by - ay
    const len = Math.hypot(ex, ey) || 1
    const c = (ex * (y - ay) - ey * (x - ax)) / len
    if (sign === 0) sign = c >= 0 ? 1 : -1
    if (c * sign < -tol) return false
  }
  return true
}

function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const x = ax + t * dx - px, y = ay + t * dy - py
  return x * x + y * y
}

function pointInRingsEvenOdd(x: number, y: number, rings: readonly Float32Array[]): boolean {
  let inside = false
  for (const r of rings) {
    const n = r.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

export interface PageHitIndex {
  page: DrawingPage
  primItem: Int32Array
  primKind: Uint8Array
  primXY: Float32Array
  /** Text item index -> its box corners. */
  textQuads: Map<number, Float32Array>
  /** CSR grid: primitives of cell c are cellPrims[cellStart[c] .. cellStart[c + 1]). */
  cellStart: Int32Array
  cellPrims: Int32Array
  nx: number
  ny: number
  cs: number
  big: number[]
  maxHalfWidth: number
}

export function buildPageHitIndex(page: DrawingPage, measure: Measure = roughMeasure): PageHitIndex {
  const { items } = page
  let prims = 0
  for (const it of items) {
    if (it.t === 'path') prims += Math.max(0, it.xy.length / 2 - 1) + (it.closed && it.xy.length > 4 ? 1 : 0)
    else if (it.t === 'segs') prims += it.xy.length / 4
    else prims += 1
  }
  const primItem = new Int32Array(prims)
  const primKind = new Uint8Array(prims)
  const primXY = new Float32Array(prims * 4)
  const textQuads = new Map<number, Float32Array>()
  let p = 0
  let maxHalfWidth = 0
  const add = (item: number, kind: number, a: number, b: number, c: number, d: number) => {
    primItem[p] = item
    primKind[p] = kind
    primXY[4 * p] = a
    primXY[4 * p + 1] = b
    primXY[4 * p + 2] = c
    primXY[4 * p + 3] = d
    p++
  }
  const addBox = (item: number, kind: number, xy: ArrayLike<number>) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let k = 0; k + 1 < xy.length; k += 2) {
      x0 = Math.min(x0, xy[k]); x1 = Math.max(x1, xy[k])
      y0 = Math.min(y0, xy[k + 1]); y1 = Math.max(y1, xy[k + 1])
    }
    if (x0 > x1) x0 = y0 = x1 = y1 = NaN // no points: a primitive nothing can hit
    add(item, kind, x0, y0, x1, y1)
  }

  items.forEach((it, i) => {
    if (it.t === 'path') {
      maxHalfWidth = Math.max(maxHalfWidth, it.w / 2)
      const xy = it.xy, n = xy.length / 2
      for (let k = 0; k + 1 < n; k++) add(i, SEGMENT, xy[2 * k], xy[2 * k + 1], xy[2 * k + 2], xy[2 * k + 3])
      if (it.closed && n > 2) add(i, SEGMENT, xy[2 * n - 2], xy[2 * n - 1], xy[0], xy[1])
    } else if (it.t === 'segs') {
      maxHalfWidth = Math.max(maxHalfWidth, it.w / 2)
      const xy = it.xy
      for (let k = 0; k + 3 < xy.length; k += 4) add(i, SEGMENT, xy[k], xy[k + 1], xy[k + 2], xy[k + 3])
    } else if (it.t === 'fill') {
      const all: number[] = []
      for (const r of it.rings) for (let k = 0; k < r.length; k++) all.push(r[k])
      addBox(i, AREA, all)
    } else if (it.t === 'text') {
      const q = textQuad(it, measure)
      textQuads.set(i, q)
      addBox(i, TEXT, q)
    } else {
      const r = it.rect
      add(i, AREA, r.x, r.y, r.x + r.w, r.y + r.h)
    }
  })

  // grid over the page (items outside it clamp to the border cells)
  const { w, h } = page.sizePt
  const target = Math.max(1, Math.sqrt(prims / 2))
  const cs = Math.max(w, h) / Math.min(MAX_CELLS_PER_AXIS, Math.max(16, Math.ceil(target)))
  const nx = Math.max(1, Math.ceil(w / cs))
  const ny = Math.max(1, Math.ceil(h / cs))
  const cx = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor(x / cs)))
  const cy = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor(y / cs)))

  const big: number[] = []
  const isBig = new Uint8Array(prims)
  for (let q = 0; q < prims; q++) {
    if (primKind[q] === SEGMENT || Number.isNaN(primXY[4 * q])) continue
    const cells = (cx(primXY[4 * q + 2]) - cx(primXY[4 * q]) + 1) * (cy(primXY[4 * q + 3]) - cy(primXY[4 * q + 1]) + 1)
    if (cells > BIG_PRIM_CELLS) {
      big.push(q)
      isBig[q] = 1
    }
  }

  const visit = (q: number, emit: (cell: number) => void) => {
    const x0 = primXY[4 * q], y0 = primXY[4 * q + 1], x1 = primXY[4 * q + 2], y1 = primXY[4 * q + 3]
    if (Number.isNaN(x0) || isBig[q]) return
    if (primKind[q] !== SEGMENT) {
      for (let j = cy(y0); j <= cy(y1); j++) for (let i = cx(x0); i <= cx(x1); i++) emit(j * nx + i)
      return
    }
    // walk the segment in half-cell steps; neighbours are covered by the query's pick radius
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (cs / 2)))
    let last = -1
    for (let s = 0; s <= steps; s++) {
      const c = cy(y0 + ((y1 - y0) * s) / steps) * nx + cx(x0 + ((x1 - x0) * s) / steps)
      if (c !== last) emit((last = c))
    }
  }
  const cellStart = new Int32Array(nx * ny + 1)
  for (let q = 0; q < prims; q++) visit(q, (c) => cellStart[c + 1]++)
  for (let c = 0; c < nx * ny; c++) cellStart[c + 1] += cellStart[c]
  const fill = cellStart.slice(0, nx * ny)
  const cellPrims = new Int32Array(cellStart[nx * ny])
  for (let q = 0; q < prims; q++) visit(q, (c) => (cellPrims[fill[c]++] = q))

  return { page, primItem, primKind, primXY, textQuads, cellStart, cellPrims, nx, ny, cs, big, maxHalfWidth }
}

/**
 * The item under (x, y) in sheet points; `tol` is the pick radius in points. Items without an element and items
 * `skip` rejects (display filters) are ignored, so a click goes through to the element below. Strokes and text win
 * over fills and images; within a class the item drawn last wins, ties go to the nearer one. Returns -1 for none.
 */
export function hitItem(index: PageHitIndex, x: number, y: number, tol: number, skip?: ((it: DrawItem) => boolean) | null): number {
  const { page, primItem, primKind, primXY, cellStart, cellPrims, nx, cs } = index
  let bestItem = -1, bestClass = -1, bestDist = Infinity
  const consider = (q: number) => {
    const item = primItem[q]
    const it = page.items[item]
    if (it.el === null || skip?.(it)) return
    let cls: number
    let dist = 0
    if (primKind[q] === SEGMENT) {
      const reach = Math.max(tol, it.t === 'path' || it.t === 'segs' ? it.w / 2 : 0)
      dist = distSqToSegment(x, y, primXY[4 * q], primXY[4 * q + 1], primXY[4 * q + 2], primXY[4 * q + 3])
      if (dist > reach * reach) return
      cls = 1
    } else if (primKind[q] === TEXT) {
      if (!pointInQuad(index.textQuads.get(item)!, x, y, tol)) return
      cls = 1
    } else {
      if (!(x >= primXY[4 * q] && x <= primXY[4 * q + 2] && y >= primXY[4 * q + 1] && y <= primXY[4 * q + 3])) return
      if (it.t === 'fill' && !pointInRingsEvenOdd(x, y, it.rings)) return
      cls = 0
    }
    if (cls > bestClass || (cls === bestClass && (item > bestItem || (item === bestItem && dist < bestDist)))) {
      bestClass = cls
      bestItem = item
      bestDist = dist
    }
  }
  const r = Math.max(tol, index.maxHalfWidth) + cs / 2
  const i0 = Math.max(0, Math.floor((x - r) / cs)), i1 = Math.min(nx - 1, Math.floor((x + r) / cs))
  const j0 = Math.max(0, Math.floor((y - r) / cs)), j1 = Math.min(index.ny - 1, Math.floor((y + r) / cs))
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const c = j * nx + i
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) consider(cellPrims[k])
    }
  for (const q of index.big) consider(q)
  return bestItem
}
