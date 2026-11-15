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
import { whenRendersIdle } from '../board/renderQueue'
import { session, getSession } from '../session'
import { openSource, type DrawingSource, type PageRenderer, type SourceInput } from '../source'
import { getDocState } from '../store'
import type { InkChoice, MarkupLayer, MarkupResult, Probe } from './pipeline'
import { MAX_AUTO_SHEETS, PROBE_DPI, candidateSheets, matchPrintedSheet, pickSheet, printedCandidates, printedScale, sheetLabel, sheetsToFinish, workingDpi } from './plan'
import type { PhotoRequest, PhotoResponse, RasterMessage } from './protocol'
import { markupToStrokes, rgbToHex } from './toStrokes'
import { tracePaper } from './trace'

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

/**
 * The worker, one request at a time. It can be started ahead of the import (warmUpPhotoImport) and even read the
 * photo before the import begins; `bind` hands it the import's progress callback and cancel signal.
 */
function createWorkerClient() {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let nextId = 1
  let pending: { id: number; resolve: (r: PhotoResponse) => void; reject: (e: Error) => void } | null = null
  let onLog: (line: string) => void = () => {}
  let signal: AbortSignal | undefined
  let decoding: { blob: Blob; reply: Promise<Reply<'decode'>> } | null = null
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
  const client = {
    /** A helper's photo decode: false if it failed (the helper then sits out). */
    ready: Promise.resolve(true),
    bind(log: (line: string) => void, sig?: AbortSignal) {
      onLog = log
      signal = sig
      sig?.addEventListener('abort', onAbort)
    },
    /** Read the photo, or take the reading already started for this very photo. */
    decode(blob: Blob): Promise<Reply<'decode'>> {
      if (decoding?.blob === blob) return decoding.reply
      const reply = client.call({ type: 'decode', blob })
      reply.catch(() => {}) // read ahead of the import, maybe never asked for
      decoding = { blob, reply }
      return reply
    },
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
  return client
}

type WorkerClient = ReturnType<typeof createWorkerClient>

/**
 * How many workers compare the photo with the candidate sheets at once. Each holds its own copy of the photo and of
 * OpenCV (a few hundred MB at the peak), so a few at most, and one core is left for rendering the sheets.
 */
function probeWorkers(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2
  return Math.max(1, Math.min(3, cores - 1))
}

/** Sheets rendered for the comparison while the dialog is open, before the import starts (at most). */
const PREFETCH_SHEETS = 6

/**
 * Work started while the import dialog is open, before the import itself: the workers (each loads the 11 MB
 * OpenCV build, about a second), the photo read as soon as it is chosen, and the first candidate sheets rendered
 * for the comparison (a raster-heavy PDF page can take many seconds the first time pdf.js draws it).
 */
const warm: {
  clients: WorkerClient[]
  sheets: { loadId: number; rasters: Map<number, Promise<RasterMessage>>; stop: boolean; abort: AbortController } | null
} = { clients: [], sheets: null }

/**
 * Get ready for an import (the dialog calls this when it opens and when the photo or the sheet choice changes):
 * start the workers it will need, have them read `file`, and render the candidate sheets.
 */
export function warmUpPhotoImport({ file, sheetId }: { file?: Blob | null; sheetId?: string } = {}): void {
  const doc = getDocState()
  if (doc.status !== 'ready' || !doc.pages || !doc.sheets.length) return
  const candidates = candidateSheets(doc.sheets, sheetId || undefined, getSession().activeSheetId)
  const n = Math.min(probeWorkers(), candidates.length)
  while (warm.clients.length > n) warm.clients.pop()!.close()
  while (warm.clients.length < n) warm.clients.push(createWorkerClient())
  if (file) for (const c of warm.clients) void c.decode(file)

  if (warm.sheets && warm.sheets.loadId !== doc.loadId) {
    warm.sheets.abort.abort()
    warm.sheets = null
  }
  const ws = (warm.sheets ??= { loadId: doc.loadId, rasters: new Map(), stop: false, abort: new AbortController() })
  ws.stop = false
  const pages = doc.pages
  void (async () => {
    for (const sheet of candidates.slice(0, PREFETCH_SHEETS)) {
      if (ws.stop || warm.sheets !== ws) return
      if (ws.rasters.has(sheet.pageIndex)) continue
      const r = renderSheetRaster(pages, sheet.pageIndex, PROBE_DPI, ws.abort.signal)
      r.catch(() => {})
      ws.rasters.set(sheet.pageIndex, r)
      await r.catch(() => {})
    }
  })()
}

/** The dialog closed: stop the work started for it. */
export function coolDownPhotoImport(): void {
  for (const c of warm.clients) c.close()
  warm.clients = []
  warm.sheets?.abort.abort()
  warm.sheets = null
}

/** A worker for the import: a warm one if there is one. */
const takeClient = (): WorkerClient => warm.clients.shift() ?? createWorkerClient()

/** A comparison render made ahead of the import, if there is one (it is handed over: its pixels go to a worker). */
function takePrefetched(loadId: number, pageIndex: number): Promise<RasterMessage> | undefined {
  const ws = warm.sheets
  if (!ws || ws.loadId !== loadId) return undefined
  const r = ws.rasters.get(pageIndex)
  ws.rasters.delete(pageIndex)
  return r
}

interface Found { sheet: Sheet; probe: Probe | null; ref: { w: number; h: number }; final: boolean; by: WorkerClient; key: number }

/**
 * Compare the photo with every candidate sheet (P1-02). The sheets are rendered one at a time (the renderer is on
 * this thread); each render goes to the first free worker, and the next sheet renders meanwhile. With several
 * sheets, each worker first does only the strict step of the match; the slower fallback steps then run where
 * sheetsToFinish says they still matter, on the worker that holds that sheet's match. The results come back in
 * candidate order, whichever worker finished first.
 */
async function findSheet(
  candidates: readonly Sheet[],
  o: { first: WorkerClient; helpers: readonly WorkerClient[]; render: (sheet: Sheet) => Promise<RasterMessage>; onSheet: (sheet: Sheet) => void; time: ReturnType<typeof stopwatch> },
): Promise<Found[]> {
  const found: Found[] = new Array(candidates.length)
  const firstOnly = candidates.length > 1
  const free: WorkerClient[] = [o.first]
  let failed: unknown = null
  let wake: (() => void) | null = null
  const nudge = () => {
    const w = wake
    wake = null
    w?.()
  }
  const release = (c: WorkerClient) => {
    free.push(c)
    nudge()
  }
  // a helper joins once it has read the photo
  for (const h of o.helpers) void h.ready.then((ok) => ok && release(h))
  const render = (sheet: Sheet) => {
    const t = performance.now()
    const p = o.render(sheet).then((ref) => ({ ref, ms: performance.now() - t }))
    p.catch(() => {}) // awaited below; a sheet still rendering when the import stops must not report an unhandled rejection
    return p
  }
  let matchMs = 0
  const running: Promise<void>[] = []
  let next = render(candidates[0])
  for (let i = 0; i < candidates.length; i++) {
    const sheet = candidates[i]
    o.onSheet(sheet)
    const t = performance.now()
    const { ref, ms } = await next
    o.time.add('sheet renders', ms, performance.now() - t)
    if (i + 1 < candidates.length) next = render(candidates[i + 1])
    while (!free.length && !failed) await new Promise<void>((r) => (wake = r))
    if (failed) break
    const c = free.shift()!
    const tp = performance.now()
    const size = { w: ref.w, h: ref.h }
    running.push(
      c.call({ type: 'probe', ref, refDpi: PROBE_DPI, key: i, firstOnly }, [ref.rgba]).then(
        ({ probe, final }) => {
          matchMs += performance.now() - tp
          found[i] = { sheet, probe, ref: size, final, by: c, key: i }
          release(c)
        },
        (e: unknown) => {
          failed ??= e
          nudge()
        },
      ),
    )
  }
  await Promise.all(running)
  if (failed) throw failed
  // the fallback steps, where they still matter: one after the other on each worker, the workers side by side
  const rest = sheetsToFinish(found)
  if (rest.length) {
    const tr = performance.now()
    const chains = new Map<WorkerClient, Promise<void>>()
    for (const f of rest) {
      const prev = chains.get(f.by) ?? Promise.resolve()
      chains.set(
        f.by,
        prev.then(async () => {
          const { probe } = await f.by.call({ type: 'probe-rest', key: f.key })
          f.probe = probe
          f.final = true
        }),
      )
    }
    await Promise.all(chains.values())
    o.time.add(`fallback matches (${rest.length} sheet${rest.length === 1 ? '' : 's'})`, performance.now() - tr, 0)
  }
  o.time.add(`sheet matches (${o.helpers.length + 1} worker${o.helpers.length ? 's' : ''})`, matchMs, 0)
  return found
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
 * Where an import's time goes, for the dialog's Details and the console: "Timings: 8.4 s in all, …; decode 0.9 s, …".
 * `lap` times the steps one after another; `add` notes the time of work that overlapped them (and, if given, how much
 * of it was waited for).
 */
function stopwatch() {
  const steps = new Map<string, { ms: number; waited: number }>()
  let mark = performance.now()
  const add = (name: string, ms: number, waited = ms) => {
    const s = steps.get(name) ?? { ms: 0, waited: 0 }
    s.ms += ms
    s.waited += waited
    steps.set(name, s)
  }
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  return {
    add,
    /** The time since the last lap, as `name`. */
    lap: (name: string) => {
      const now = performance.now()
      add(name, now - mark)
      mark = now
    },
    summary: (total: number, sheets: number) =>
      `Timings: ${sec(total)} in all, ${sheets} sheet${sheets === 1 ? '' : 's'} compared; ` +
      [...steps].filter(([, s]) => s.ms >= 50).map(([name, s]) => `${name} ${sec(s.ms)}${s.waited < s.ms - 50 && s.waited > 0 ? ` (${sec(s.waited)} waited)` : ''}`).join(', '),
  }
}

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

  // the sheets left to render ahead are rendered by the import itself, in its own order
  if (warm.sheets) warm.sheets.stop = true
  const client = takeClient()
  client.bind(say, opts.signal)
  let helpers: WorkerClient[] = []
  let printed: { source: DrawingSource; name: string; sheets: Sheet[]; pages: PageRenderer } | null = null
  try {
    if (opts.printed) printed = await openPrinted(opts.printed)
    // the drawing the photo is matched against: the printed file, else the open document
    const refPages = printed?.pages ?? pages
    // with the open sheet chosen, the printed pages titled like it are compared first, wherever they are in the file
    const target = doc.sheets.find((s) => s.id === opts.sheetId)
    const candidates = printed ? printedCandidates(printed.sheets, target, MAX_AUTO_SHEETS) : candidateSheets(doc.sheets, opts.sheetId, getSession().activeSheetId)
    if (!candidates.length) throw new PhotoImportError(printed ? `${printed.name} has no pages to match the photo against.` : 'That sheet is not in the open document.')

    const time = stopwatch()
    say('Reading the photo…')
    // with several sheets to compare, more workers compare them side by side; each reads the photo itself
    helpers = Array.from({ length: Math.min(candidates.length, probeWorkers()) - 1 }, () => {
      const h = takeClient()
      h.bind(() => {}, opts.signal)
      h.ready = h.decode(photo).then(() => true, () => false)
      return h
    })
    const size = await client.decode(photo)
    time.lap('decode')
    say(`Photo ${size.w} × ${size.h} px`)

    // 1. which sheet is in the photo? Every candidate is compared: look-alike sheets can each match well.
    // The sheets are rendered here one after the other, and each is compared with the photo by whichever worker is
    // free, while the next one renders.
    const probes = await findSheet(candidates, {
      first: client,
      helpers,
      render: (sheet) => (!printed && takePrefetched(loadId, sheet.pageIndex)) || renderSheetRaster(refPages, sheet.pageIndex, PROBE_DPI, opts.signal),
      onSheet: (sheet) => {
        const label = printed ? `${printed.name}, page ${sheet.pageIndex + 1}` : sheetLabel(sheet)
        say(candidates.length > 1 ? `Looking for the sheet: ${label}…` : `Matching the photo to ${label}…`)
      },
      time,
    })
    // the trace runs in the first worker; the others are done
    for (const h of helpers) h.close()
    time.lap('find the sheet')
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
    time.lap('pick the sheet')
    const ref = await renderSheetRaster(refPages, refSheet.pageIndex, dpi, opts.signal)
    time.lap('render sheet for tracing')
    // the registration starts from the probe's match instead of matching features all over again
    const pr = probes.find((p) => p.sheet === refSheet)!
    const seed = { H: best.probe.H, w: pr.ref.w, h: pr.ref.h, inliers: best.probe.inliers, matches: best.probe.matches }
    const { result } = await client.call({ type: 'run', ref, dpi, options: { ink: opts.ink ?? 'both', seed } }, [ref.rgba])
    time.lap('align and trace')

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
      // P1-12: the strokes arrive on a sheet of trace paper, unrolled over the drawing once the sheet has been
      // drawn at the new zoom (pdf.js renders on the main thread and would make the roll stutter)
      void unrollWhenDrawn(sheet.id)
    }
    const line = time.summary(performance.now() - t0, candidates.length)
    say(line)
    console.info(`[photo] ${line}`)
    return summarize(sheet, groupId, result, strokes.length, dpi, performance.now() - t0, printedFrom)
  } finally {
    client.close()
    for (const h of helpers) h.close()
    void printed?.source.close()
  }
}

const nextFrame = () => new Promise<void>((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)))

async function unrollWhenDrawn(sheetId: string) {
  await nextFrame()
  await nextFrame()
  await whenRendersIdle(2500)
  await nextFrame()
  tracePaper.unroll(sheetId)
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
