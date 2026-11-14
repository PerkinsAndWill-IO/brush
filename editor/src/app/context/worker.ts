/**
 * Web Worker: opens the PDF with its own pdf.js document, extracts RawPageContent and runs inferContext,
 * so none of the work touches the main thread. Protocol in ./protocol.ts; use ./client.ts.
 */
import './worker-shim'
import { GlobalWorkerOptions, OPS, getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { inferContext } from '@core/context'
import { CONTEXT_DOC_PARAMS, extractPage, type PdfOps, type PdfPageLike } from './extract'
import type { ContextRequest, ContextResponse } from './protocol'

GlobalWorkerOptions.workerSrc = workerUrl

const scope = self as unknown as {
  postMessage(message: ContextResponse): void
  onmessage: ((e: MessageEvent<ContextRequest>) => void) | null
}

let task: PDFDocumentLoadingTask | null = null
let doc: PDFDocumentProxy | null = null

async function handle(req: ContextRequest): Promise<ContextResponse> {
  if (req.type === 'open' || req.type === 'close') {
    if (task) await task.destroy().catch(() => undefined)
    task = null
    doc = null
    if (req.type === 'close') return { id: req.id, ok: true, type: 'close' }
    // images are dropped at parse time: context needs vectors and text only (see CONTEXT_DOC_PARAMS)
    task = getDocument(typeof req.source === 'string' ? { url: req.source, ...CONTEXT_DOC_PARAMS } : { data: req.source, ...CONTEXT_DOC_PARAMS })
    doc = await task.promise
    return { id: req.id, ok: true, type: 'open', pages: doc.numPages }
  }
  if (!doc) throw new Error('no document open')
  const m = /^sheet-(\d+)$/.exec(req.sheetId)
  if (!m) throw new Error(`bad sheet id ${req.sheetId}`)
  const t0 = performance.now()
  const page = await doc.getPage(Number(m[1]) + 1)
  const { raw, partial } = await extractPage(page as unknown as PdfPageLike, req.sheetId, OPS as unknown as PdfOps, { imagesSkipped: true })
  const context = inferContext(raw, { partial })
  page.cleanup()
  return { id: req.id, ok: true, type: 'context', context, buildMs: performance.now() - t0 }
}

scope.onmessage = (e) => {
  const req = e.data
  handle(req).then(
    (res) => scope.postMessage(res),
    (err: unknown) => scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  )
}
