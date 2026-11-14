/**
 * Canvas renderer for `.drawing` pages (decision 0008). Items are already in sheet points (top-left, y down), so a
 * page draws with one uniform scale: no y flip, text is not mirrored. Strokes are batched per style run (the schema
 * viewer's approach) and, within a run, per cell of a grid over the page, so a region render (the zoomed-in detail
 * raster) strokes only the batches that reach into the region.
 * Lines never draw thinner than one device pixel. Images decode once per page (createImageBitmap) and are cached.
 */
import type { DrawItem, DrawingPage, DrawText } from '@core/drawing'
import type { Rect } from '@core/types'

type Box = { x0: number; y0: number; x1: number; y1: number }
/** A batch of strokes of one style, near each other: one Path2D and the box around its points. */
export type Part = Box & { path: Path2D; points: number }

type Cmd =
  | { k: 'stroke'; parts: Part[]; w: number; css: string; dash: number[] }
  | { k: 'fill'; path: Path2D; css: string; box: Box }
  | { k: 'text'; item: DrawText }
  | { k: 'image'; item: Extract<DrawItem, { t: 'image' }> }

const css = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`
/** Points per stroke batch: Chrome's GPU canvas silently draws nothing for one Path2D of millions of points. */
const BATCH_POINTS = 100_000
/** Buckets per side of the page grid strokes are sorted into, so a region render strokes only the buckets it touches. */
const GRID = 16
/** Bucket of strokes too long for one cell (kept whole: joins and dashes must not break). */
const BIG = GRID * GRID

function boxOf(xy: ArrayLike<number>): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let k = 0; k + 1 < xy.length; k += 2) {
    const x = xy[k]
    const y = xy[k + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

/**
 * Compile a page into draw commands. Within a run of consecutive strokes (draw order does not matter there), items
 * are bucketed per style into a GRID x GRID grid over the page by their centre; any other item ends the run, so draw
 * order across kinds is kept. `newPath` exists for tests (Path2D is a browser API).
 */
export function compile(page: DrawingPage, hide: ((it: DrawItem) => boolean) | null, newPath: () => Path2D = () => new Path2D()): Cmd[] {
  const cmds: Cmd[] = []
  const cw = page.sizePt.w / GRID
  const ch = page.sizePt.h / GRID
  let run = new Map<string, { cmd: Cmd & { k: 'stroke' }; cells: (Part | undefined)[] }>()
  const flush = () => {
    for (const r of run.values()) cmds.push(r.cmd)
    run = new Map()
  }
  /** The open part (room for more points) of the cell holding box x0..x1, y0..y1, grown to cover it. */
  const partFor = (r: { cmd: Cmd & { k: 'stroke' }; cells: (Part | undefined)[] }, x0: number, y0: number, x1: number, y1: number, n: number): Part => {
    // too long for one cell: kept whole in its own bucket (joins and dashes must not break)
    const cell =
      x1 - x0 > 2 * cw || y1 - y0 > 2 * ch
        ? BIG
        : Math.min(GRID - 1, Math.max(0, Math.floor((y0 + y1) / 2 / ch))) * GRID + Math.min(GRID - 1, Math.max(0, Math.floor((x0 + x1) / 2 / cw))) || 0
    let p = r.cells[cell]
    if (!p || p.points >= BATCH_POINTS) {
      r.cells[cell] = p = { path: newPath(), points: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      r.cmd.parts.push(p)
    }
    if (x0 < p.x0) p.x0 = x0
    if (y0 < p.y0) p.y0 = y0
    if (x1 > p.x1) p.x1 = x1
    if (y1 > p.y1) p.y1 = y1
    p.points += n
    return p
  }
  for (const it of page.items) {
    if (hide?.(it)) continue
    if (it.t === 'path' || it.t === 'segs') {
      const key = `${it.w}|${it.c.join(',')}|${it.dash.join(',')}`
      let r = run.get(key)
      if (!r) run.set(key, (r = { cmd: { k: 'stroke', parts: [], w: it.w, css: css(it.c), dash: it.dash }, cells: [] }))
      const xy = it.xy
      if (it.t === 'path') {
        if (xy.length < 4) continue
        const b = boxOf(xy)
        const path = partFor(r, b.x0, b.y0, b.x1, b.y1, xy.length / 2).path
        path.moveTo(xy[0], xy[1])
        for (let k = 2; k < xy.length; k += 2) path.lineTo(xy[k], xy[k + 1])
        if (it.closed) path.closePath()
      } else {
        // independent segments: each goes to its own bucket
        for (let k = 0; k + 3 < xy.length; k += 4) {
          const ax = xy[k]
          const ay = xy[k + 1]
          const bx = xy[k + 2]
          const by = xy[k + 3]
          const path = partFor(r, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), 2).path
          path.moveTo(ax, ay)
          path.lineTo(bx, by)
        }
      }
      continue
    }
    flush()
    if (it.t === 'fill') {
      const path = newPath()
      let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
      for (const r of it.rings) {
        if (r.length < 4) continue
        const b = boxOf(r)
        box = { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) }
        path.moveTo(r[0], r[1])
        for (let k = 2; k < r.length; k += 2) path.lineTo(r[k], r[k + 1])
        path.closePath()
      }
      cmds.push({ k: 'fill', path, css: css(it.c), box })
    } else if (it.t === 'text') cmds.push({ k: 'text', item: it })
    else cmds.push({ k: 'image', item: it })
  }
  flush()
  return cmds
}

const hits = (b: Box, r: Rect, pad: number) => b.x0 - pad < r.x + r.w && b.x1 + pad > r.x && b.y0 - pad < r.y + r.h && b.y1 + pad > r.y

/** Parts of a stroke command that reach into `r` (sheet points), counting the line width (at least `minPt`). */
export function partsIn(cmd: Cmd & { k: 'stroke' }, r: Rect, minPt: number): Part[] {
  const pad = Math.max(cmd.w, minPt)
  return cmd.parts.filter((p) => hits(p, r, pad))
}

/** Compiled commands per page, for the filter version they were built with. */
const compiled = new WeakMap<DrawingPage, { key: number; cmds: Cmd[] }>()
const bitmaps = new WeakMap<Uint8Array, Promise<ImageBitmap | null>>()

function bitmap(png: Uint8Array): Promise<ImageBitmap | null> {
  let p = bitmaps.get(png)
  if (!p) {
    // an image the browser cannot decode is skipped (spec)
    p = createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' })).catch(() => null)
    bitmaps.set(png, p)
  }
  return p
}

/** Arial cap height in em, and line height (as in the viewer's text layout). */
const CAP_EM = 0.716
const LINE_EM = 1.2

function wrap(g: CanvasRenderingContext2D, text: string, maxWidth: number | null): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (maxWidth === null) {
      out.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(' ')) {
      const cand = line === '' ? word : `${line} ${word}`
      if (line !== '' && g.measureText(cand).width > maxWidth) {
        out.push(line)
        line = word
      } else line = cand
    }
    out.push(line)
  }
  return out
}

function drawText(g: CanvasRenderingContext2D, t: DrawText, minPx: number) {
  const em = t.size / CAP_EM
  if (em < 2 * minPx) return // below ~2 device px: unreadable, skip
  g.save()
  g.font = `${t.bold ? 'bold ' : ''}${em}px Arial, sans-serif`
  g.fillStyle = css(t.c)
  g.textBaseline = 'alphabetic'
  const h = t.anchor[0]
  g.textAlign = h === 'l' ? 'left' : h === 'r' ? 'right' : 'center'
  const lines = wrap(g, t.text, t.maxWidth)
  const lineH = em * LINE_EM
  const height = lines.length * lineH
  const fy = t.anchor[1] === 't' ? 0 : t.anchor[1] === 'b' ? 1 : 0.5
  g.translate(t.at.x, t.at.y)
  g.rotate(Math.atan2(t.dir.y, t.dir.x))
  const top = -height * fy
  lines.forEach((line, n) => g.fillText(line, 0, top + n * lineH + lineH / 2 + t.size / 2))
  g.restore()
}

/**
 * Render a page into `canvas` at `pxPerPt` device pixels per sheet point (sets the backing size only; the board
 * sizes the canvas with CSS). Awaits the page's images. `gate` pauses between chunks while the pen is down.
 * `filter` drops items from the drawing (display filters); its `key` must change whenever `hide` does.
 * `region` (sheet points) renders only that part of the page, so a zoomed-in view can be drawn at full resolution
 * without a page-sized backing store; the canvas then covers exactly `region`.
 */
export async function renderDrawingPage(
  page: DrawingPage,
  canvas: HTMLCanvasElement,
  pxPerPt: number,
  signal?: AbortSignal,
  gate?: () => Promise<void> | null,
  filter?: { key: number; hide: ((it: DrawItem) => boolean) | null },
  region?: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const key = filter?.key ?? -1
  let entry = compiled.get(page)
  if (!entry || entry.key !== key) compiled.set(page, (entry = { key, cmds: compile(page, filter?.hide ?? null) }))
  const cmds = entry.cmds
  const images = new Map<DrawItem, ImageBitmap | null>()
  await Promise.all(cmds.filter((c) => c.k === 'image').map(async (c) => images.set(c.item, await bitmap(c.item.png))))
  const wait = gate?.()
  if (wait) await wait
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const r0 = region ?? { x: 0, y: 0, w: page.sizePt.w, h: page.sizePt.h }
  const w = Math.max(1, Math.round(r0.w * pxPerPt))
  const h = Math.max(1, Math.round(r0.h * pxPerPt))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('renderDrawingPage: no 2D context')
  canvas.width = w
  canvas.height = h
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = '#fff'
  g.fillRect(0, 0, w, h)
  g.setTransform(pxPerPt, 0, 0, pxPerPt, -r0.x * pxPerPt, -r0.y * pxPerPt)
  g.lineJoin = 'round'
  g.lineCap = 'butt'
  const minPx = 1 / pxPerPt // one device pixel in points
  for (const c of cmds) {
    if (c.k === 'stroke') {
      const parts = partsIn(c, r0, minPx)
      if (!parts.length) continue
      g.lineWidth = Math.max(c.w, minPx)
      g.strokeStyle = c.css
      g.setLineDash(c.dash)
      for (const p of parts) g.stroke(p.path)
      g.setLineDash([])
    } else if (c.k === 'fill') {
      if (!hits(c.box, r0, minPx)) continue
      g.fillStyle = c.css
      g.fill(c.path, 'evenodd')
    } else if (c.k === 'text') drawText(g, c.item, minPx)
    else {
      const bmp = images.get(c.item)
      const r = c.item.rect
      if (!bmp || !hits({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }, r0, 0)) continue
      g.save()
      g.imageSmoothingEnabled = false
      g.drawImage(bmp, r.x, r.y, r.w, r.h)
      g.restore()
    }
  }
}
