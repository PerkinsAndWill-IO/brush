/**
 * Import hand markup from a photo of a printed sheet (task P1).
 *
 *   photo -> worker: decode
 *   each candidate sheet -> rendered small here, matched in the worker -> the sheet in the photo
 *   that sheet -> rendered at the working resolution here -> worker: register, isolate ink, trace strokes
 *   strokes -> the session, as one undo step
 *
 * The sheets are rendered on the main thread with the document's own `PageRenderer` (pdf.js or the `.drawing`
 * vector renderer); everything else happens in the photo worker, which is the only place OpenCV is loaded.
 */
import type { Sheet } from '@core/types'
import { boardView } from '../board/Board'
import { session, getSession } from '../session'
import type { PageRenderer } from '../source'
import { getDocState } from '../store'
import type { InkChoice, MarkupResult, Probe } from './pipeline'
import { PROBE_DPI, candidateSheets, pickSheet, sheetLabel, workingDpi } from './plan'
import type { PhotoRequest, PhotoResponse, RasterMessage } from './protocol'
import { markupToStrokes, rgbToHex } from './toStrokes'

export interface PhotoImportOptions {
  /** Sheet the photo shows. Leave out to find it among the open sheets. */
  sheetId?: string
  /** Which pens to pick up (default: all). */
  ink?: InkChoice
  onProgress?: (line: string) => void
  signal?: AbortSignal
  /** Tests: do not move the camera to the sheet afterwards. */
  keepCamera?: boolean
}

export interface PhotoImportSummary {
  sheetId: string
  /** "A102 Plans" */
  sheetLabel: string
  /** Strokes added to the session. */
  strokes: number
  layers: { name: string; color: string; strokes: number }[]
  /** Median registration error on the sheet, mm (absent when the fine registration could not lock on). */
  residualMm?: number
  /** Share of the sheet the photo covers, 0..1. */
  coverage?: number
  /** Working resolution, dpi on the sheet. */
  dpi: number
  ms: number
}

export class PhotoImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoImportError'
  }
}

type RequestType = PhotoRequest['type']
type Reply<T extends RequestType> = Extract<PhotoResponse, { ok: true; type: T }>
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

/** The worker, one request at a time. */
function createWorkerClient(onLog: (line: string) => void, signal?: AbortSignal) {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let nextId = 1
  let pending: { id: number; resolve: (r: PhotoResponse) => void; reject: (e: Error) => void } | null = null
  const fail = (e: Error) => {
    pending?.reject(e)
    pending = null
  }
  worker.onmessage = (e: MessageEvent<PhotoResponse>) => {
    const msg = e.data
    if (!('ok' in msg)) return onLog(msg.line)
    if (!pending || pending.id !== msg.id) return
    const p = pending
    pending = null
    if (msg.ok) p.resolve(msg)
    else p.reject(new PhotoImportError(msg.error))
  }
  worker.onerror = (e) => fail(new PhotoImportError(e.message || 'the photo worker crashed (out of memory?)'))
  const onAbort = () => {
    worker.terminate()
    fail(new DOMException('Import cancelled', 'AbortError'))
  }
  signal?.addEventListener('abort', onAbort)
  return {
    call<T extends RequestType>(req: DistributiveOmit<PhotoRequest, 'id'> & { type: T }, transfer: Transferable[] = []): Promise<Reply<T>> {
      if (signal?.aborted) return Promise.reject(new DOMException('Import cancelled', 'AbortError'))
      return new Promise<PhotoResponse>((resolve, reject) => {
        const id = nextId++
        pending = { id, resolve, reject }
        worker.postMessage({ ...req, id }, transfer)
      }) as Promise<Reply<T>>
    },
    close() {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Render a sheet as it is printed, at `dpi`, and read the pixels back. */
export async function renderSheetRaster(pages: PageRenderer, pageIndex: number, dpi: number, signal?: AbortSignal): Promise<RasterMessage> {
  const canvas = document.createElement('canvas')
  await pages.render(pageIndex, canvas, dpi / 72, signal)
  // a raster-heavy PDF page may come back as an image-less preview first; the full page lands in the same canvas
  for (let waited = 0; canvas.dataset.preview === '1' && waited < 60_000; waited += 100) await sleep(100)
  const g = canvas.getContext('2d')
  if (!g || !canvas.width || !canvas.height) throw new PhotoImportError('could not render the sheet')
  const img = g.getImageData(0, 0, canvas.width, canvas.height)
  canvas.width = canvas.height = 0 // release the backing store now
  return { rgba: img.data.buffer as ArrayBuffer, w: img.width, h: img.height }
}

let importSeq = 0

/**
 * Trace the pen and marker markup in `photo` and add it to the session as brush strokes on the sheet it was
 * drawn on. One undo step. Rejects with a `PhotoImportError` (message for the user) or an `AbortError`.
 */
export async function importPhotoMarkup(photo: Blob, opts: PhotoImportOptions = {}): Promise<PhotoImportSummary> {
  const t0 = performance.now()
  const doc = getDocState()
  const pages = doc.pages
  if (doc.status !== 'ready') throw new PhotoImportError('Open the drawing first, then import the photo of its markup.')
  if (!pages) throw new PhotoImportError('This document has no drawing to match the photo against.')
  const loadId = doc.loadId
  const say = opts.onProgress ?? (() => {})
  const candidates = candidateSheets(doc.sheets, opts.sheetId, getSession().activeSheetId)
  if (!candidates.length) throw new PhotoImportError('That sheet is not in the open document.')

  const client = createWorkerClient(say, opts.signal)
  try {
    say('Reading the photo…')
    const size = await client.call({ type: 'decode', blob: photo })
    say(`Photo ${size.w} × ${size.h} px`)

    // 1. which sheet is in the photo? Every candidate is compared: look-alike sheets can each match well
    const probes: { sheet: Sheet; probe: Probe | null }[] = []
    for (const sheet of candidates) {
      say(candidates.length > 1 ? `Looking for the sheet: ${sheetLabel(sheet)}…` : `Matching the photo to ${sheetLabel(sheet)}…`)
      const ref = await renderSheetRaster(pages, sheet.pageIndex, PROBE_DPI, opts.signal)
      const { probe } = await client.call({ type: 'probe', ref, refDpi: PROBE_DPI }, [ref.rgba])
      probes.push({ sheet, probe })
    }
    const best = pickSheet(probes)
    if (!best) {
      const tried = doc.sheets.length > candidates.length && !opts.sheetId ? ` (tried the first ${candidates.length} of ${doc.sheets.length} sheets; choose the sheet to try another)` : ''
      throw new PhotoImportError(
        opts.sheetId
          ? `The photo does not match ${sheetLabel(candidates[0])}. Check that it shows this sheet, flat and in focus.`
          : `The photo does not match any open sheet${tried}. Check that it shows a sheet of this drawing, flat and in focus.`,
      )
    }
    const { sheet } = best

    // 2. trace the markup against the sheet at the working resolution
    const dpi = workingDpi(best.probe.seenDpi, sheet.sizePt)
    say(`${sheetLabel(sheet)}: the photo resolves about ${Math.round(best.probe.seenDpi)} dpi on the sheet; tracing at ${dpi} dpi…`)
    const ref = await renderSheetRaster(pages, sheet.pageIndex, dpi, opts.signal)
    const { result } = await client.call({ type: 'run', ref, dpi, options: { ink: opts.ink ?? 'both' } }, [ref.rgba])

    // 3. into the session, unless the document changed meanwhile
    if (getDocState().loadId !== loadId) throw new PhotoImportError('Another file was opened while the photo was being read; nothing was imported.')
    const strokes = markupToStrokes(result.layers, { sheetId: sheet.id, idPrefix: `p${Date.now().toString(36)}${(importSeq++).toString(36)}-`, startedAt: Date.now() })
    if (strokes.length) {
      session.addStrokes(strokes)
      session.setActiveSheet(sheet.id)
      if (!opts.keepCamera) boardView.focusSheet(sheet.pageIndex)
    }
    return summarize(sheet, result, strokes.length, dpi, performance.now() - t0)
  } finally {
    client.close()
  }
}

function summarize(sheet: Sheet, result: MarkupResult, strokes: number, dpi: number, ms: number): PhotoImportSummary {
  const r = result.report
  return {
    sheetId: sheet.id,
    sheetLabel: sheetLabel(sheet),
    strokes,
    layers: result.layers.map((l) => ({ name: l.name, color: rgbToHex(l.color), strokes: l.strokes.length })),
    residualMm: r.offsetFinal === undefined ? undefined : (r.offsetFinal / dpi) * 25.4,
    coverage: r.sheetCoverage,
    dpi,
    ms,
  }
}
