/**
 * Canvas renderer for `.drawing` pages (decision 0008). Items are already in sheet points (top-left, y down), so a
 * page draws with one uniform scale: no y flip, text is not mirrored. Strokes are batched into one Path2D per
 * style run (the schema viewer's approach), so even large sheets paint in a few stroke() calls.
 * Lines never draw thinner than one device pixel. Images decode once per page (createImageBitmap) and are cached.
 */
import type { DrawItem, DrawingPage, DrawText } from '@core/drawing'

type Cmd =
  | { k: 'stroke'; path: Path2D; w: number; css: string; dash: number[]; points: number }
  | { k: 'fill'; path: Path2D; css: string }
  | { k: 'text'; item: DrawText }
  | { k: 'image'; item: Extract<DrawItem, { t: 'image' }> }

const css = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`
/** Points per stroke batch: Chrome's GPU canvas silently draws nothing for one Path2D of millions of points. */
const BATCH_POINTS = 100_000

function compile(page: DrawingPage): Cmd[] {
  const cmds: Cmd[] = []
  // consecutive stroke items merge per style; any other item ends the run, so draw order across kinds is kept
  let run = new Map<string, Cmd & { k: 'stroke' }>()
  const flush = () => {
    for (const c of run.values()) cmds.push(c)
    run = new Map()
  }
  for (const it of page.items) {
    if (it.t === 'path' || it.t === 'segs') {
      const key = `${it.w}|${it.c.join(',')}|${it.dash.join(',')}`
      let cmd = run.get(key)
      if (cmd && cmd.points >= BATCH_POINTS) {
        cmds.push(cmd) // same style, so drawing it ahead of the rest of the run keeps the picture
        cmd = undefined
      }
      if (!cmd) run.set(key, (cmd = { k: 'stroke', path: new Path2D(), w: it.w, css: css(it.c), dash: it.dash, points: 0 }))
      const xy = it.xy
      cmd.points += xy.length / 2
      if (it.t === 'path') {
        if (xy.length < 4) continue
        cmd.path.moveTo(xy[0], xy[1])
        for (let k = 2; k < xy.length; k += 2) cmd.path.lineTo(xy[k], xy[k + 1])
        if (it.closed) cmd.path.closePath()
      } else {
        for (let k = 0; k + 3 < xy.length; k += 4) {
          cmd.path.moveTo(xy[k], xy[k + 1])
          cmd.path.lineTo(xy[k + 2], xy[k + 3])
        }
      }
      continue
    }
    flush()
    if (it.t === 'fill') {
      const path = new Path2D()
      for (const r of it.rings) {
        if (r.length < 4) continue
        path.moveTo(r[0], r[1])
        for (let k = 2; k < r.length; k += 2) path.lineTo(r[k], r[k + 1])
        path.closePath()
      }
      cmds.push({ k: 'fill', path, css: css(it.c) })
    } else if (it.t === 'text') cmds.push({ k: 'text', item: it })
    else cmds.push({ k: 'image', item: it })
  }
  flush()
  return cmds
}

const compiled = new WeakMap<DrawingPage, Cmd[]>()
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
 */
export async function renderDrawingPage(
  page: DrawingPage,
  canvas: HTMLCanvasElement,
  pxPerPt: number,
  signal?: AbortSignal,
  gate?: () => Promise<void> | null,
): Promise<void> {
  let cmds = compiled.get(page)
  if (!cmds) compiled.set(page, (cmds = compile(page)))
  const images = new Map<DrawItem, ImageBitmap | null>()
  await Promise.all(cmds.filter((c) => c.k === 'image').map(async (c) => images.set(c.item, await bitmap(c.item.png))))
  const wait = gate?.()
  if (wait) await wait
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const w = Math.max(1, Math.floor(page.sizePt.w * pxPerPt))
  const h = Math.max(1, Math.floor(page.sizePt.h * pxPerPt))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('renderDrawingPage: no 2D context')
  canvas.width = w
  canvas.height = h
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = '#fff'
  g.fillRect(0, 0, w, h)
  g.setTransform(pxPerPt, 0, 0, pxPerPt, 0, 0)
  g.lineJoin = 'round'
  g.lineCap = 'butt'
  const minPx = 1 / pxPerPt // one device pixel in points
  for (const c of cmds) {
    if (c.k === 'stroke') {
      g.lineWidth = Math.max(c.w, minPx)
      g.strokeStyle = c.css
      g.setLineDash(c.dash)
      g.stroke(c.path)
      g.setLineDash([])
    } else if (c.k === 'fill') {
      g.fillStyle = c.css
      g.fill(c.path, 'evenodd')
    } else if (c.k === 'text') drawText(g, c.item, minPx)
    else {
      const bmp = images.get(c.item)
      if (!bmp) continue
      const r = c.item.rect
      g.save()
      g.imageSmoothingEnabled = false
      g.drawImage(bmp, r.x, r.y, r.w, r.h)
      g.restore()
    }
  }
}
