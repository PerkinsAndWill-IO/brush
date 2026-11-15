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
 *
 * P1-09: the paper in the photo may be a print of another file than the one open (the PDF of a sheet whose
 * `.drawing` is open): drawn in another style, it hardly matches the open sheet. Given that file, the photo is
 * matched to its pages instead, and the strokes are moved onto the open sheet that page is (same layout).
 */
import type { Sheet } from '@core/types'
import { boardView } from '../board/Board'
import { session, getSession } from '../session'
import { openSource, type DrawingSource, type PageRenderer, type SourceInput } from '../source'
import { getDocState } from '../store'
import type { InkChoice, MarkupLayer, MarkupResult, Probe } from './pipeline'
import { MAX_AUTO_SHEETS, PROBE_DPI, candidateSheets, matchPrintedSheet, pickSheet, printedCandidates, printedScale, sheetLabel, workingDpi } from './plan'
import type { PhotoRequest, PhotoResponse, RasterMessage } from './protocol'
import { markupToStrokes, rgbToHex } from './toStrokes'

export interface PhotoImportOptions {
  /** Sheet the photo shows (with `printed`: the open sheet the strokes go on). Leave out to find it. */
  sheetId?: string
  /** The file the paper in the photo was printed from, when it is not the open one (P1-09). */
  printed?: SourceInput
  /** Which pens to pick up (default: all). */
  ink?: InkChoice
  onProgress?: (line: string) => void
  signal?: AbortSignal
  /** Tests: do not move the camera to the sheet afterwards. */
  keepCamera?: boolean
}

export interface PhotoImportSummary {
  sheetId: string
  /** The import's stroke group (./groups.ts): the id prefix of its strokes. */
  groupId: string
  /** "A102 Plans" */
  sheetLabel: string
  /** P1-09: the printed file's page the photo was matched to ("plans.pdf, page 3"). */
  printedFrom?: string
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
  constructor(
    message: string,
    /** 'no-match': the photo matched none of the open sheets; the printed file may help (P1-09). */
    readonly code?: 'no-match',
  ) {
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
  if (opts.sheetId && !doc.sheets.some((s) => s.id === opts.sheetId)) throw new PhotoImportError('That sheet is not in the open document.')

  const client = createWorkerClient(say, opts.signal)
  let printed: { source: DrawingSource; name: string; sheets: Sheet[]; pages: PageRenderer } | null = null
  try {
    if (opts.printed) printed = await openPrinted(opts.printed)
    // the drawing the photo is matched against: the printed file, else the open document
    const refPages = printed?.pages ?? pages
    // with the open sheet chosen, the printed pages titled like it are compared first, wherever they are in the file
    const target = doc.sheets.find((s) => s.id === opts.sheetId)
    const candidates = printed ? printedCandidates(printed.sheets, target, MAX_AUTO_SHEETS) : candidateSheets(doc.sheets, opts.sheetId, getSession().activeSheetId)
    if (!candidates.length) throw new PhotoImportError(printed ? `${printed.name} has no pages to match the photo against.` : 'That sheet is not in the open document.')

    say('Reading the photo…')
    const size = await client.call({ type: 'decode', blob: photo })
    say(`Photo ${size.w} × ${size.h} px`)

    // 1. which sheet is in the photo? Every candidate is compared: look-alike sheets can each match well
    const probes: { sheet: Sheet; probe: Probe | null }[] = []
    for (const sheet of candidates) {
      const label = printed ? `${printed.name}, page ${sheet.pageIndex + 1}` : sheetLabel(sheet)
      say(candidates.length > 1 ? `Looking for the sheet: ${label}…` : `Matching the photo to ${label}…`)
      const ref = await renderSheetRaster(refPages, sheet.pageIndex, PROBE_DPI, opts.signal)
      const { probe } = await client.call({ type: 'probe', ref, refDpi: PROBE_DPI }, [ref.rgba])
      probes.push({ sheet, probe })
    }
    const best = pickSheet(probes)
    if (!best) {
      if (printed) {
        const some = printed.sheets.length > candidates.length ? ` (compared the first ${candidates.length} of its ${printed.sheets.length} pages${target ? ', those titled like the chosen sheet first' : '; choose the sheet the strokes go on to compare its page first'})` : ''
        throw new PhotoImportError(`The photo does not match ${printed.sheets.length === 1 ? 'the page' : 'any page'} of ${printed.name}${some}. Check that the paper in the photo was printed from this file, and that the photo is flat and in focus.`)
      }
      const tried = doc.sheets.length > candidates.length && !opts.sheetId ? ` (tried the first ${candidates.length} of ${doc.sheets.length} sheets; choose the sheet to try another)` : ''
      throw new PhotoImportError(
        (opts.sheetId
          ? `The photo does not match ${sheetLabel(candidates[0])}. Check that it shows this sheet, flat and in focus.`
          : `The photo does not match any open sheet${tried}. Check that it shows a sheet of this drawing, flat and in focus.`) +
          ' If the paper was printed from another file (the PDF of this sheet, say), its drawing may look too different: choose that file and the photo is matched to it instead.',
        'no-match',
      )
    }

    // P1-09: the open sheet the strokes go on, and the scale from the printed page to it
    const sheet = printed ? matchPrintedSheet(best.sheet, printed.sheets.length, doc.sheets, opts.sheetId) : best.sheet
    const printedFrom = printed ? `${printed.name}, page ${best.sheet.pageIndex + 1}` : undefined
    if (!sheet) throw new PhotoImportError(`The photo matches ${printedFrom}, but it is not clear which open sheet that page is. Choose the sheet under "Sheet in the photo" and import again.`)
    const scale = printed ? printedScale(best.sheet.sizePt, sheet.sizePt) : { sx: 1, sy: 1 }
    if (!scale) throw new PhotoImportError(`${printedFrom} and ${sheetLabel(sheet)} have different page proportions, so they are not the same sheet layout. Choose the sheet the page was printed from.`)
    if (printed) say(`The photo shows ${printedFrom}; the strokes go on ${sheetLabel(sheet)}.`)

    // 2. trace the markup against the matched page at the working resolution
    const refSheet = best.sheet
    const dpi = workingDpi(best.probe.seenDpi, refSheet.sizePt)
    say(`${printedFrom ?? sheetLabel(refSheet)}: the photo resolves about ${Math.round(best.probe.seenDpi)} dpi on the sheet; tracing at ${dpi} dpi…`)
    const ref = await renderSheetRaster(refPages, refSheet.pageIndex, dpi, opts.signal)
    const { result } = await client.call({ type: 'run', ref, dpi, options: { ink: opts.ink ?? 'both' } }, [ref.rgba])

    // 3. into the session, unless the document changed meanwhile
    if (getDocState().loadId !== loadId) throw new PhotoImportError('Another file was opened while the photo was being read; nothing was imported.')
    // the id prefix is the import's group (./groups.ts): p<time><seq>-
    const groupId = `p${Date.now().toString(36)}${(importSeq++).toString(36)}-`
    const layers = scale.sx === 1 && scale.sy === 1 ? result.layers : scaleLayers(result.layers, scale.sx, scale.sy)
    const strokes = markupToStrokes(layers, { sheetId: sheet.id, idPrefix: groupId, startedAt: Date.now() })
    if (strokes.length) {
      session.addStrokes(strokes)
      session.setActiveSheet(sheet.id)
      if (!opts.keepCamera) boardView.focusSheet(sheet.pageIndex)
    }
    return summarize(sheet, groupId, result, strokes.length, dpi, performance.now() - t0, printedFrom)
  } finally {
    client.close()
    void printed?.source.close()
  }
}

/** Open the printed file (P1-09) for matching only: it is not shown and not kept. */
async function openPrinted(input: SourceInput): Promise<{ source: DrawingSource; name: string; sheets: Sheet[]; pages: PageRenderer }> {
  let source: DrawingSource
  try {
    source = await openSource(input)
  } catch (e) {
    throw new PhotoImportError(`Could not open the printed file: ${(e as Error).message || e}`)
  }
  try {
    const loaded = await source.load()
    if (!loaded.pages || !loaded.sheets.length) throw new PhotoImportError(`${source.name} has no pages to match the photo against.`)
    return { source, name: source.name, sheets: loaded.sheets, pages: loaded.pages }
  } catch (e) {
    void source.close()
    throw e instanceof PhotoImportError ? e : new PhotoImportError(`Could not open the printed file: ${(e as Error).message || e}`)
  }
}

/** Strokes traced on the printed page, in the open sheet's points. */
function scaleLayers(layers: readonly MarkupLayer[], sx: number, sy: number): MarkupLayer[] {
  const sw = Math.sqrt(sx * sy)
  return layers.map((l) => ({ ...l, strokes: l.strokes.map((s) => ({ ...s, width: s.width * sw, points: s.points.map(([x, y]) => [x * sx, y * sy] as [number, number]) })) }))
}

function summarize(sheet: Sheet, groupId: string, result: MarkupResult, strokes: number, dpi: number, ms: number, printedFrom?: string): PhotoImportSummary {
  const r = result.report
  return {
    sheetId: sheet.id,
    groupId,
    sheetLabel: sheetLabel(sheet),
    printedFrom,
    strokes,
    layers: result.layers.map((l) => ({ name: l.name, color: rgbToHex(l.color), strokes: l.strokes.length })),
    residualMm: r.offsetFinal === undefined ? undefined : (r.offsetFinal / dpi) * 25.4,
    coverage: r.sheetCoverage,
    dpi,
    ms,
  }
}
