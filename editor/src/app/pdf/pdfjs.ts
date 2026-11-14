/**
 * Thin wrapper around pdfjs-dist (pinned 6.5.438). The only place the app
 * talks to pdf.js. API checked against node_modules/pdfjs-dist/types:
 *  - GlobalWorkerOptions.workerSrc must be set before getDocument
 *  - render() takes { canvas, viewport } (canvasContext is legacy)
 */
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Sheet } from '@core/types'

GlobalWorkerOptions.workerSrc = workerUrl

/** A page label like "A-201" is a sheet number (shown in mono above the sheet). */
const SHEET_NUMBER = /^[A-Z]{1,3}[-. ]?\d{1,4}(\.\d+)?$/i

export interface LoadedPdf {
  doc: PDFDocumentProxy
  sheets: Sheet[]
  /** Frees the document and its worker (pdf.js 6: destroy lives on the loading task). */
  destroy(): Promise<void>
}

export type PdfSource = string | ArrayBuffer | Uint8Array

/** Load a PDF from a URL or bytes, returning one Sheet per page. Throws on unreadable input. */
export async function loadPdf(src: PdfSource): Promise<LoadedPdf> {
  const params =
    typeof src === 'string'
      ? { url: src }
      : { data: src instanceof Uint8Array ? src : new Uint8Array(src) }
  const task = getDocument({ ...params, verbosity: 0 })
  const doc = await task.promise
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
  return { doc, sheets, destroy: () => task.destroy() }
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

/**
 * Render a page (0-based) into `canvas` at `pxPerPt` device pixels per PDF
 * point. Only sets the backing size; the caller sizes the canvas with CSS
 * (the board scales it with the camera). Used for M1-05 re-renders.
 */
export async function renderPageAt(
  doc: PDFDocumentProxy,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  pxPerPt: number,
  signal?: AbortSignal,
  /** Called between render chunks; returning a promise pauses rendering until it resolves (ink priority). */
  gate?: () => Promise<void> | null,
): Promise<void> {
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
  signal?.addEventListener('abort', onAbort)
  try {
    await task.promise
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
