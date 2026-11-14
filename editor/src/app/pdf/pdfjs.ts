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
    sheets.push({
      id: `sheet-${i}`,
      pageIndex: i,
      name: label ? label : `Sheet ${i + 1}`,
      sizePt: { w: vp.width, h: vp.height },
    })
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
