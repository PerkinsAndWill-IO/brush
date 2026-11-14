/**
 * Thin wrapper around pdfjs-dist (pinned 6.5.438). The only place the app
 * talks to pdf.js. API checked against node_modules/pdfjs-dist/types:
 *  - GlobalWorkerOptions.workerSrc must be set before getDocument
 *  - render() takes { canvas, viewport } (canvasContext is legacy)
 *  - getDocument({ maxImageSize }) drops images larger than that many pixels at parse time
 *  - PDFPageProxy._abortOperatorList keeps the operator list alive while another render task of the page runs
 *
 * Raster-heavy pages (decision 0006). Real CAD/BIM exports can carry hundreds of large image tiles per page
 * (KRO A0 sheets: ~590 JPEG+SMask tiles, ~150 Mpx per page). pdf.js decodes every tile before it can paint,
 * so the first full render of such a page takes 10-20 s. loadPdf therefore also opens a *preview* document
 * with images dropped (`maxImageSize: 0`, own pdf.js worker). renderPageAt starts the full render offscreen;
 * if it is not done within PREVIEW_AFTER_MS it paints the vector + text preview into the caller's canvas and
 * resolves, then copies the full render over it when that finishes (canvas `data-preview="1"` until then).
 * Pages that render fast take the plain path, unchanged. Once a page has completed one full render, later
 * renders (zoom, M1-05) are plain: pdf.js has the decoded images cached and the old raster stays on screen.
 */
import { GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { parseTitleBlock } from '@core/context'
import type { Sheet } from '@core/types'
import { textsFromContent } from '../context/extract'

GlobalWorkerOptions.workerSrc = workerUrl

/** A page label like "A-201" is a sheet number (shown in mono above the sheet). */
const SHEET_NUMBER = /^[A-Z]{1,3}[-. ]?\d{1,4}(\.\d+)?$/i

/** A full render slower than this shows the image-less preview first. */
export const PREVIEW_AFTER_MS = 350
/** Title-block reading (sheet number / name) may delay loadPdf by at most this much. */
const TITLE_BUDGET_MS = 700

export interface LoadedPdf {
  doc: PDFDocumentProxy
  sheets: Sheet[]
  /** Frees the document and its worker (pdf.js 6: destroy lives on the loading task). */
  destroy(): Promise<void>
}

export type PdfSource = string | ArrayBuffer | Uint8Array

interface PreviewState {
  task: PDFDocumentLoadingTask
  doc: Promise<PDFDocumentProxy | null>
  /** Pages with at least one completed full render. */
  fullDone: Set<number>
  /** Latest renderPageAt call per page, to drop stale background copies. */
  gen: Map<number, number>
  /** Background full renders still running, per page. */
  background: Map<number, () => void>
  /**
   * Full renders of not-yet-rendered pages run one at a time, in request order (the board requests visible
   * sheets first): pdf.js would otherwise decode every page's images interleaved and all pages land late.
   */
  fullChain: Promise<unknown>
}

const previews = new WeakMap<PDFDocumentProxy, PreviewState>()

/** Load a PDF from a URL or bytes, returning one Sheet per page. Throws on unreadable input. */
export async function loadPdf(src: PdfSource): Promise<LoadedPdf> {
  const bytes = typeof src === 'string' ? null : src instanceof Uint8Array ? src : new Uint8Array(src)
  // pdf.js transfers (detaches) the buffer it is given: both documents get their own copy, the caller's bytes stay
  // usable (a DrawingSource hands the same bytes to the context worker)
  const previewParams = bytes ? { data: bytes.slice() } : { url: src as string }
  const task = getDocument({ ...(bytes ? { data: bytes.slice() } : { url: src as string }), verbosity: 0 })
  const previewTask = getDocument({ ...previewParams, verbosity: 0, maxImageSize: 0 })
  const previewDoc = previewTask.promise.catch(() => null)
  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (e) {
    void previewTask.destroy()
    throw e
  }
  previews.set(doc, { task: previewTask, doc: previewDoc, fullDone: new Set(), gen: new Map(), background: new Map(), fullChain: Promise.resolve() })
  const labels = await doc.getPageLabels().catch(() => null)
  const sheets: Sheet[] = []
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1)
    // scale 1 viewport = PDF points; rotation applied, y already flipped.
    const vp = page.getViewport({ scale: 1 })
    const label = labels?.[i]?.trim()
    const sheet: Sheet = {
      id: `sheet-${i}`,
      pageIndex: i,
      name: label ? label : `Sheet ${i + 1}`,
      sizePt: { w: vp.width, h: vp.height },
    }
    if (label && SHEET_NUMBER.test(label)) sheet.number = label
    sheets.push(sheet)
  }
  await nameFromTitleBlocks(previewDoc, sheets)
  return {
    doc,
    sheets,
    destroy: async () => {
      for (const stop of previews.get(doc)?.background.values() ?? []) stop()
      await Promise.all([task.destroy(), previewTask.destroy()])
    },
  }
}

/**
 * Sheet number and name from each page's title block (text only, on the image-less document), e.g.
 * "KRO-APD-ARC-PLN-A1A-N01-0001-007" / "PLAN GENERAL · LOT A1A · PLAN N01". Page labels are kept when the
 * title block says nothing; the whole step is capped at TITLE_BUDGET_MS so it never holds up the first sheet.
 */
async function nameFromTitleBlocks(previewDoc: Promise<PDFDocumentProxy | null>, sheets: Sheet[]): Promise<void> {
  const work = (async () => {
    const pdoc = await previewDoc
    if (!pdoc) return
    await Promise.all(
      sheets.map(async (sheet) => {
        const page = await pdoc.getPage(sheet.pageIndex + 1)
        const tc = await page.getTextContent()
        const texts = textsFromContent(tc.items, page.getViewport({ scale: 1 }).transform)
        const tb = parseTitleBlock({ sheetId: sheet.id, sizePt: sheet.sizePt, paths: [], texts })
        if (tb.number) sheet.number = tb.number
        if (tb.name) sheet.name = tb.name
        else if (tb.number && /^Sheet \d+$/.test(sheet.name)) sheet.name = tb.number
        if (tb.scale !== undefined && tb.scale >= 1) sheet.scale = tb.scale
      }),
    )
  })().catch(() => undefined)
  await Promise.race([work, new Promise((r) => setTimeout(r, TITLE_BUDGET_MS))])
}

/** Render a page (0-based) into a canvas at `scale` CSS px per PDF point. */
export async function renderPage(
  doc: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  scale = 1,
  signal?: AbortSignal,
): Promise<void> {
  const page = await doc.getPage(pageIndex + 1)
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const viewport = page.getViewport({ scale: scale * dpr })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
  const task = page.render({ canvas, viewport })
  const onAbort = () => task.cancel()
  signal?.addEventListener('abort', onAbort)
  try {
    await task.promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

type Gate = () => Promise<void> | null

/** Plain pdf.js render of a page into `canvas` at `pxPerPt`; sets the backing size. */
async function renderInto(doc: PDFDocumentProxy, pageIndex: number, canvas: HTMLCanvasElement, pxPerPt: number, signal?: AbortSignal, gate?: Gate): Promise<void> {
  const page = await doc.getPage(pageIndex + 1)
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const viewport = page.getViewport({ scale: pxPerPt })
  canvas.width = Math.max(1, Math.floor(viewport.width))
  canvas.height = Math.max(1, Math.floor(viewport.height))
  const task = page.render({ canvas, viewport })
  if (gate) {
    task.onContinue = (cont: () => void) => {
      const wait = gate()
      if (wait) void wait.then(cont)
      else cont()
    }
  }
  const onAbort = () => task.cancel()
  if (signal?.aborted) onAbort()
  signal?.addEventListener('abort', onAbort)
  try {
    await task.promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

const sleep = (ms: number) => new Promise<'slow'>((r) => setTimeout(() => r('slow'), ms))

/**
 * Render a page (0-based) into `canvas` at `pxPerPt` device pixels per PDF
 * point. Only sets the backing size; the caller sizes the canvas with CSS
 * (the board scales it with the camera). Used for M1-05 re-renders.
 * On a raster-heavy page's first render this may resolve with an image-less preview in `canvas`
 * (`canvas.dataset.preview === '1'`) and paint the full page into the same canvas later.
 */
export async function renderPageAt(
  doc: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  pxPerPt: number,
  signal?: AbortSignal,
  /** Called between render chunks; returning a promise pauses rendering until it resolves (ink priority). */
  gate?: Gate,
): Promise<void> {
  const st = previews.get(doc)
  if (!st || st.fullDone.has(pageIndex) || typeof document === 'undefined') {
    await renderInto(doc, pageIndex, canvas, pxPerPt, signal, gate)
    if (st) st.fullDone.add(pageIndex)
    return
  }
  const gen = (st.gen.get(pageIndex) ?? 0) + 1
  st.gen.set(pageIndex, gen)
  // full render offscreen, with its own abort so it can outlive this call
  const fullAc = new AbortController()
  const full = document.createElement('canvas')
  const fullP = st.fullChain.then(() => renderInto(doc, pageIndex, full, pxPerPt, fullAc.signal, gate))
  st.fullChain = fullP.catch(() => undefined)
  // a newer request for this page supersedes an older background render (started first, so pdf.js keeps the
  // page's operator list alive for the new one)
  st.background.get(pageIndex)?.()
  st.background.set(pageIndex, () => fullAc.abort())
  const onAbort = () => fullAc.abort()
  signal?.addEventListener('abort', onAbort)
  const copy = () => {
    canvas.width = full.width
    canvas.height = full.height
    canvas.getContext('2d')?.drawImage(full, 0, 0)
    delete canvas.dataset.preview
  }
  const finish = () => {
    if (st.background.get(pageIndex) && st.gen.get(pageIndex) === gen) st.background.delete(pageIndex)
    signal?.removeEventListener('abort', onAbort)
  }
  try {
    const first = await Promise.race([fullP.then(() => 'full' as const), sleep(PREVIEW_AFTER_MS)])
    if (first === 'full') {
      st.fullDone.add(pageIndex)
      copy()
      finish()
      return
    }
  } catch (e) {
    finish()
    throw e
  }
  // slow page: paint the image-less preview now
  const pdoc = await st.doc
  if (signal?.aborted) {
    fullAc.abort()
    finish()
    throw new DOMException('aborted', 'AbortError')
  }
  if (pdoc) {
    try {
      await renderInto(pdoc, pageIndex, canvas, pxPerPt, signal, gate)
      canvas.dataset.preview = '1'
    } catch (e) {
      if (signal?.aborted) {
        fullAc.abort()
        finish()
        throw e
      }
      // preview failed: fall through and wait for the full render instead
      await fullP.finally(finish)
      st.fullDone.add(pageIndex)
      copy()
      return
    }
  } else {
    await fullP.finally(finish)
    st.fullDone.add(pageIndex)
    copy()
    return
  }
  // the caller shows the preview; the full render lands in the same canvas when done
  signal?.removeEventListener('abort', onAbort)
  fullP.then(
    () => {
      st.fullDone.add(pageIndex)
      if (st.gen.get(pageIndex) === gen) copy()
      finish()
    },
    () => finish(),
  )
}
