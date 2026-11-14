/**
 * pdf.js page -> RawPageContent (sheet coordinates: PDF points, top-left origin, y down).
 *
 * Works in the browser and in Node. This file never imports pdf.js: the caller
 * injects the `OPS` enum (`import { OPS } from 'pdfjs-dist'`, or the legacy build in Node)
 * and a page proxy. API checked against pdfjs-dist 6.5.438:
 *  - page.getOperatorList() -> { fnArray, argsArray }
 *  - OPS.constructPath args = [finalOp, [Float32Array | null], minMax | null]; the Float32Array
 *    holds DrawOPS-encoded segments (0 moveTo x y, 1 lineTo x y, 2 curveTo x1 y1 x2 y2 x y,
 *    3 quadraticCurveTo x1 y1 x y, 4 closePath) in the CTM's user space.
 *    rectangle / curveTo2 / curveTo3 are already folded into those four by the worker.
 *  - OPS.setGState args = [[key, value], ...] with 'LW' and 'D' ([dashArray, phase]).
 *  - page.getViewport({scale:1}).transform maps user space to sheet space.
 */
import type { Point, RawPageContent, RawPath, RawText } from '@core/types'

/** The subset of pdf.js `OPS` this extractor uses (all numbers). */
export interface PdfOps {
  save: number
  restore: number
  transform: number
  setLineWidth: number
  setDash: number
  setGState: number
  constructPath: number
  stroke: number
  closeStroke: number
  fill: number
  eoFill: number
  fillStroke: number
  eoFillStroke: number
  closeFillStroke: number
  closeEOFillStroke: number
  paintFormXObjectBegin: number
  paintFormXObjectEnd: number
  paintImageXObject: number
  paintInlineImageXObject: number
  paintImageMaskXObject?: number
}

/** The subset of PDFPageProxy this extractor uses. */
export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] }
  getOperatorList(): Promise<{ fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }>
  getTextContent(): Promise<{ items: ReadonlyArray<unknown> }>
}

// DrawOPS (pdfjs-dist 6.5.438 src/shared/util.js)
const D_MOVE = 0
const D_LINE = 1
const D_CURVE = 2
const D_QUAD = 3
const D_CLOSE = 4

type M = [number, number, number, number, number, number]

/** a*b: apply b first, then a (column-vector convention, PDF [a b c d e f]). */
function mul(a: M, b: M): M {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

function applyM(m: M, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

function scaleOf(m: M): number {
  const det = Math.abs(m[0] * m[3] - m[1] * m[2])
  return det > 0 ? Math.sqrt(det) : 1
}

interface GState {
  ctm: M
  lineWidth: number
  dash: number[]
}

function bezierSteps(len: number): number {
  return Math.max(4, Math.min(16, Math.ceil(len / 6)))
}

function flatten(data: ArrayLike<number>, m: M): Array<{ points: Point[]; closed: boolean }> {
  const out: Array<{ points: Point[]; closed: boolean }> = []
  let cur: Point[] = []
  let start: Point | null = null
  let last: Point | null = null
  const flush = (closed: boolean) => {
    if (cur.length >= 2 || (closed && cur.length >= 2)) out.push({ points: cur, closed })
    cur = []
  }
  for (let i = 0; i < data.length; ) {
    const op = data[i++]
    if (op === D_MOVE) {
      flush(false)
      const p = applyM(m, data[i++], data[i++])
      cur = [p]
      start = last = p
    } else if (op === D_LINE) {
      const p = applyM(m, data[i++], data[i++])
      if (!last) {
        cur = [p]
        start = p
      } else cur.push(p)
      last = p
    } else if (op === D_CURVE || op === D_QUAD) {
      const p0: Point = last ?? applyM(m, data[i], data[i + 1])
      let c1: Point
      let c2: Point
      let p3: Point
      if (op === D_CURVE) {
        c1 = applyM(m, data[i++], data[i++])
        c2 = applyM(m, data[i++], data[i++])
        p3 = applyM(m, data[i++], data[i++])
      } else {
        const q = applyM(m, data[i++], data[i++])
        p3 = applyM(m, data[i++], data[i++])
        c1 = { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) }
        c2 = { x: p3.x + (2 / 3) * (q.x - p3.x), y: p3.y + (2 / 3) * (q.y - p3.y) }
      }
      if (!last) {
        cur = [p0]
        start = p0
      }
      const len = Math.hypot(c1.x - p0.x, c1.y - p0.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(p3.x - c2.x, p3.y - c2.y)
      const n = bezierSteps(len)
      for (let k = 1; k <= n; k++) {
        const t = k / n
        const u = 1 - t
        cur.push({
          x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
        })
      }
      last = p3
    } else if (op === D_CLOSE) {
      if (cur.length >= 2) {
        // drop duplicate closing vertex
        const f = cur[0]
        const l = cur[cur.length - 1]
        if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) cur.pop()
        flush(true)
      } else cur = []
      // a subpath after close starts at the previous start point
      if (start) {
        cur = [start]
        last = start
      }
    } else {
      break // unknown op: stop rather than misread the buffer
    }
  }
  flush(false)
  // a lone start point left by closePath is not a path
  return out.filter((p) => p.points.length >= 2)
}

interface TextItemLike {
  str: string
  transform: number[]
  width: number
  height: number
}

function isTextItem(x: unknown): x is TextItemLike {
  const o = x as TextItemLike
  return !!o && typeof o.str === 'string' && Array.isArray(o.transform)
}

/** Extract one page. `sheetId` is `sheet-<pageIndex>`. */
export async function extractPageContent(page: PdfPageLike, sheetId: string, OPS: PdfOps): Promise<RawPageContent> {
  const vp = page.getViewport({ scale: 1 })
  const base: M = [vp.transform[0], vp.transform[1], vp.transform[2], vp.transform[3], vp.transform[4], vp.transform[5]]
  const [opList, textContent] = await Promise.all([page.getOperatorList(), page.getTextContent()])
  const { fnArray, argsArray } = opList

  const paths: RawPath[] = []
  let images = 0
  let gs: GState = { ctm: base, lineWidth: 1, dash: [] }
  const stack: GState[] = []

  const emit = (data: ArrayLike<number>, op: number) => {
    const stroke = op === OPS.stroke || op === OPS.closeStroke || op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke
    const fill = op === OPS.fill || op === OPS.eoFill || op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke
    if (!stroke && !fill) return
    const s = scaleOf(gs.ctm)
    const lineWidth = gs.lineWidth * s
    const dash = gs.dash.length ? gs.dash.map((d) => d * s) : undefined
    for (const sub of flatten(data, gs.ctm)) {
      paths.push({ points: sub.points, closed: sub.closed, lineWidth, dash, stroked: stroke, filled: fill })
    }
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i] as unknown[] | null
    if (fn === OPS.save) stack.push({ ...gs })
    else if (fn === OPS.restore) {
      const p = stack.pop()
      if (p) gs = p
    } else if (fn === OPS.transform && args) {
      gs = { ...gs, ctm: mul(gs.ctm, args as unknown as M) }
    } else if (fn === OPS.paintFormXObjectBegin && args) {
      stack.push({ ...gs })
      if (Array.isArray(args[0])) gs = { ...gs, ctm: mul(gs.ctm, args[0] as M) }
    } else if (fn === OPS.paintFormXObjectEnd) {
      const p = stack.pop()
      if (p) gs = p
    } else if (fn === OPS.setLineWidth && args) {
      gs = { ...gs, lineWidth: Number(args[0]) }
    } else if (fn === OPS.setDash && args) {
      gs = { ...gs, dash: Array.isArray(args[0]) ? (args[0] as number[]) : [] }
    } else if (fn === OPS.setGState && Array.isArray(args?.[0])) {
      for (const entry of args[0] as Array<[string, unknown]>) {
        if (entry[0] === 'LW') gs = { ...gs, lineWidth: Number(entry[1]) }
        else if (entry[0] === 'D' && Array.isArray(entry[1])) gs = { ...gs, dash: Array.isArray(entry[1][0]) ? (entry[1][0] as number[]) : [] }
      }
    } else if (fn === OPS.constructPath && args) {
      const data = (args[1] as Array<ArrayLike<number> | null>)[0]
      if (data) emit(data, args[0] as number)
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || (OPS.paintImageMaskXObject !== undefined && fn === OPS.paintImageMaskXObject)) {
      images++
    }
  }

  const texts: RawText[] = []
  for (const it of textContent.items) {
    if (!isTextItem(it) || !it.str.trim()) continue
    const t = it.transform
    const tm = mul(base, [t[0], t[1], t[2], t[3], t[4], t[5]])
    const p = applyM(tm, 0, 0)
    // font size = length of the y basis vector in sheet space
    const size = Math.hypot(tm[2], tm[3]) || it.height * scaleOf(base)
    const width = it.width * scaleOf(base)
    texts.push({ text: it.str, x: p.x, y: p.y, width, height: size })
  }

  // Raster-only: images present and (almost) no vector content or text.
  const hasRasterOnly = images > 0 && paths.length < 5 && texts.length === 0
  const out: RawPageContent = { sheetId, sizePt: { w: vp.width, h: vp.height }, paths, texts }
  if (hasRasterOnly) out.hasRasterOnly = true
  return out
}
