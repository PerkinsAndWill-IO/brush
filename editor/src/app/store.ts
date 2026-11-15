/**
 * Document store: the open PDF and its sheets, shared by the React tree and
 * the test API. Opening binds the stroke session to the PDF's sidecar.
 */
import { useSyncExternalStore } from 'react'
import type { Sheet } from '@core/types'
import { layoutSheets, type Placement } from './board/layout'
import type { OpenedFile } from './platform'
import { closeSession, openEphemeralSession, openSession } from './session'
import { closeContexts, openContexts, refreshContexts, type ContextProvider } from './brain/contextStore'
import { DrawingFileSource, openSource, watchPages, type DrawingSource, type PageRenderer } from './source'
import { resetLive } from './brain/live'
import { startConversion, ConversionCancelled, type Conversion } from './convertClient'
import type { ConvertProgress } from './convertProgress'

export type DocStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface DocState {
  status: DocStatus
  fileName?: string
  fileSize?: number
  /** Draws the sheet images (pdf.js or the `.drawing` vector renderer); undefined when there is nothing to draw (sheets draw blank). */
  pages?: PageRenderer
  /** The open source (M5): PDF or `.drawing` package. */
  source?: DrawingSource
  destroy?: () => Promise<void>
  sheets: Sheet[]
  placements: Placement[]
  error?: string
  /** While a Revit model converts (status 'loading'): where the conversion stands. */
  progress?: ConvertProgress
  /** Bytes downloaded so far while a document opens by URL. */
  openedBytes?: number
  /** Bumped per load so views can re-render pages. */
  loadId: number
}

let state: DocState = { status: 'empty', sheets: [], placements: [], loadId: 0 }
const listeners = new Set<() => void>()

function set(next: Partial<DocState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export function getDocState(): DocState {
  return state
}

export function subscribeDoc(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/**
 * Sheets of the open `.drawing` ready to show, of all, while the rest load in the background. Kept apart from DocState:
 * a change per sheet must not re-render the board.
 */
let sheetsLoading: [number, number] | undefined
const loadingListeners = new Set<() => void>()
function setSheetsLoading(v: [number, number] | undefined) {
  sheetsLoading = v
  loadingListeners.forEach((l) => l())
}
export function useSheetsLoading(): [number, number] | undefined {
  return useSyncExternalStore(
    (l) => {
      loadingListeners.add(l)
      return () => loadingListeners.delete(l)
    },
    () => sheetsLoading,
  )
}

export function useDocState(): DocState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

/* first-page-rendered signal, used by the test API to resolve loadPdf */
let firstPageWaiters: Array<{ loadId: number; resolve: () => void }> = []
let firstPageRenderedFor = 0

export function notifyPageRendered(loadId: number, pageIndex: number) {
  if (pageIndex !== 0) return
  firstPageRenderedFor = loadId
  firstPageWaiters.filter((w) => w.loadId === loadId).forEach((w) => w.resolve())
  firstPageWaiters = firstPageWaiters.filter((w) => w.loadId !== loadId)
}

export function waitForFirstPage(loadId: number): Promise<void> {
  if (firstPageRenderedFor === loadId) return Promise.resolve()
  return new Promise((resolve) => firstPageWaiters.push({ loadId, resolve }))
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] // %PDF

/** Cheap check before pdf.js: name or header must say PDF (M1-02). */
export function looksLikePdf(name: string, bytes?: ArrayBuffer | Uint8Array): boolean {
  if (bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    // the header may follow a little junk; pdf.js accepts it within the first 1 KB
    const head = u.subarray(0, 1024)
    for (let i = 0; i + 3 < head.length; i++) if (PDF_MAGIC.every((b, k) => head[i + k] === b)) return true
    return false
  }
  return /\.pdf$/i.test(name)
}

export interface OpenOptions {
  size?: number
  path?: string
  /** What to show while this opens, when it is the last step of a conversion. Other opens clear any progress. */
  progress?: ConvertProgress
}

/** The conversion in flight, if any: opening anything else supersedes it. */
let conversion: Conversion | undefined
function supersedeConversion() {
  conversion?.cancel()
  conversion = undefined
}

/** Resolves once the main thread is idle (a timer where requestIdleCallback is missing), so background work waits for paint. */
const idle = () =>
  new Promise<void>((resolve) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 1000 }) : setTimeout(resolve, 0)))

// Contexts of a host model are built on the main thread, one sheet per idle period (a `.drawing` page is decoded then).
const contextsFrom = (src: DrawingSource): ContextProvider => ({
  open: async () => {},
  getContext: async (id) => {
    await idle()
    return src.contextFor(id)
  },
  close: () => {},
})

/**
 * Open a PDF or a `.drawing` package (M5 source: sniffed by content). Errors keep the
 * empty state and set `error` (M1-02). Sheets come from the source, contexts from
 * `source.contextFor` (inferred for PDFs, from the manifest for packages).
 */
export async function openDocument(input: string | ArrayBuffer | Uint8Array, fileName: string, opts: OpenOptions = {}): Promise<number> {
  const loadId = state.loadId + 1
  const prev = state.source
  const size = opts.size ?? (typeof input === 'string' ? 0 : input.byteLength)
  if (!opts.progress) supersedeConversion()
  set({ status: 'loading', fileName, fileSize: size, loadId, error: undefined, openedBytes: undefined, progress: opts.progress })
  setSheetsLoading(undefined)
  let source: DrawingSource | undefined
  // the download, shown on the start page; a set per 256 kB is enough
  const onBytes = (n: number) => {
    if (loadId === state.loadId && n - (state.openedBytes ?? 0) >= 1 << 18) set({ openedBytes: n })
  }
  try {
    // copy: pdf.js may transfer (detach) the buffer it is given
    const bytes = typeof input === 'string' ? null : input instanceof Uint8Array ? input.slice() : new Uint8Array(input.slice(0))
    // own copy for the context worker: PdfDrawingSource hands the same buffer to pdf.js, which detaches it
    const ctxBytes = bytes?.slice()
    source = await openSource(bytes ? { name: fileName, bytes } : (input as string), {}, onBytes)
    const { sheets, pages } = source instanceof DrawingFileSource ? source.loadFirst() : await source.load()
    if (sheets.length === 0) throw new Error(`“${fileName}” has no sheets.`)
    if (loadId !== state.loadId) {
      void source.close()
      return loadId
    }
    void prev?.close()
    resetLive()
    await openSession({ name: source.name, size, path: opts.path }, sheets.map((s) => s.id))
    set({
      status: 'ready',
      progress: undefined,
      fileName: source.name,
      pages: pages ?? undefined,
      source,
      sheets,
      placements: layoutSheets(sheets),
      destroy: () => source!.close(),
    })
    if (source instanceof DrawingFileSource) {
      const src = source
      watchPages(src.doc, (done, total) => {
        if (state.source === src) setSheetsLoading(done < total ? [done, total] : undefined)
      })
    }
    const ids = sheets.map((s) => s.id)
    if (source.kind === 'pdf') void openContexts(ctxBytes ?? (input as string), ids) // inferred in the context worker
    else {
      // from the host model (.drawing elements or package manifest); a `.drawing` then lists every page's scale
      const src = source
      void openContexts('', ids, contextsFrom(src)).then(() => {
        if (src instanceof DrawingFileSource) void refreshSource(src, [])
      })
    }
    return loadId
  } catch (e) {
    void source?.close()
    // a later open took over while this one loaded: leave it be
    if (loadId !== state.loadId) throw e
    void prev?.close()
    closeSession()
    closeContexts()
    resetLive()
    const msg = (e as Error).message ?? String(e)
    const error = /not a PDF/i.test(msg)
      ? `“${fileName}” is not a PDF or a .drawing package. Choose a .pdf or .drawing file.`
      : `Could not read “${fileName}”. It may be damaged. (${msg})`
    set({ status: 'error', progress: undefined, pages: undefined, source: undefined, destroy: undefined, sheets: [], placements: [], error })
    throw e
  }
}

/**
 * Open a source that is already built and loaded, with a session that is not saved to a sidecar (M6: a Revit
 * sheet, whose model is the record). Same states as openDocument.
 */
export async function openLinkedSource(source: DrawingSource, opts: { size?: number } = {}): Promise<number> {
  const loadId = state.loadId + 1
  const prev = state.source
  supersedeConversion()
  set({ status: 'loading', fileName: source.name, fileSize: opts.size ?? 0, loadId, error: undefined, progress: undefined })
  const { sheets, pages } = await source.load()
  if (loadId !== state.loadId) return loadId
  if (prev && prev !== source) void prev.close()
  resetLive()
  await openEphemeralSession()
  set({
    status: 'ready',
    progress: undefined,
    fileName: source.name,
    pages: pages ?? undefined,
    source,
    sheets,
    placements: layoutSheets(sheets),
    destroy: () => source.close(),
  })
  void openContexts('', sheets.map((s) => s.id), contextsFrom(source))
  return loadId
}

const samePlacement = (a: Placement, b: Placement) => a.sheetId === b.sheetId && a.pageIndex === b.pageIndex && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/**
 * The open source changed some of its sheets in place (M6-04: a new version from Revit, a sheet added or closed).
 * Re-reads its sheets without touching the session, the camera or `loadId`. Unchanged sheets keep their Sheet and
 * Placement objects, so only the changed ones re-render. Contexts of `changed` sheets are rebuilt.
 */
export async function refreshSource(source: DrawingSource, changed: readonly string[]): Promise<void> {
  if (state.source !== source || state.status !== 'ready') return
  const loaded = await source.load()
  if (state.source !== source) return
  // a sheet whose fields did not change keeps its object, so its page is not rendered again. A sheet in `changed`
  // always takes the new object: its drawing changed (a new Revit version) even when its name, size and number did not.
  const was = new Map(state.sheets.map((s) => [s.id, s]))
  const redo = new Set(changed)
  const sheets = loaded.sheets.map((s) => (!redo.has(s.id) && JSON.stringify(was.get(s.id)) === JSON.stringify(s) ? was.get(s.id)! : s))
  const pages = loaded.pages
  const old = new Map(state.placements.map((p) => [p.sheetId, p]))
  const placements = layoutSheets(sheets).map((p) => {
    const o = old.get(p.sheetId)
    return o && samePlacement(o, p) ? o : p
  })
  set({ sheets, placements, pages: pages ?? undefined })
  refreshContexts(sheets.map((s) => s.id), changed)
}

/**
 * Where a Revit model goes to become a `.drawing`: a conversion server you run yourself, which answers `POST` (the
 * model's bytes, its URI-encoded name in `X-Filename`) with the `.drawing` file, or (asked with `Prefer:
 * respond-async`) with where to follow the conversion's progress (`convertClient.ts`). `VITE_RVT_CONVERT_URL` moves it.
 */
const RVT_CONVERT_URL: string = import.meta.env.VITE_RVT_CONVERT_URL ?? 'http://127.0.0.1:4100/convert'

/** Send a Revit model to the conversion server and open the `.drawing` it answers with. Same states as openDocument, plus `progress` while it converts. */
async function openRevitModel(file: OpenedFile): Promise<void> {
  supersedeConversion()
  const loadId = state.loadId + 1
  set({ status: 'loading', fileName: `${file.name}, converting to .drawing`, fileSize: file.size, loadId, error: undefined, progress: undefined })
  const running = startConversion({ url: RVT_CONVERT_URL, name: file.name, bytes: file.bytes }, (progress) => {
    // another file was opened meanwhile: its late progress is not shown, and the conversion stops
    if (loadId !== state.loadId) return running.cancel()
    set({ progress })
  })
  conversion = running
  let bytes: ArrayBuffer
  try {
    bytes = await running.result
  } catch (e) {
    if (e instanceof ConversionCancelled || loadId !== state.loadId) return // another file was opened meanwhile
    if (conversion === running) conversion = undefined
    void state.source?.close()
    closeSession()
    closeContexts()
    resetLive()
    const error = `Could not convert “${file.name}” to a .drawing at ${RVT_CONVERT_URL}. Is the conversion server running? (${(e as Error).message})`
    set({ status: 'error', progress: undefined, pages: undefined, source: undefined, destroy: undefined, sheets: [], placements: [], error })
    return
  }
  if (conversion === running) conversion = undefined
  if (loadId !== state.loadId) return
  const opening: ConvertProgress = { phase: 'open', label: 'Opening', fraction: 0.99, elapsedMs: state.progress?.elapsedMs ?? 0 }
  await openDocument(bytes, file.name.replace(/\.(rvt|rfa)$/i, '.drawing'), { size: bytes.byteLength, progress: opening }).catch(() => {})
}

/**
 * M6-11: asked before a `.rvt` goes to the conversion server. Resolves true when that model is open in Revit and the
 * live link took it instead. Set by the Revit controller (kept as a hook so the store does not import it).
 */
let revitModelHook: ((fileName: string) => Promise<boolean>) | null = null
export function setRevitModelHook(hook: typeof revitModelHook) {
  revitModelHook = hook
}

/** The model is open in Revit: show the start page, where the link panel lists its sheets. */
async function takeRevitModel(file: OpenedFile): Promise<boolean> {
  if (!revitModelHook || !/\.rvt$/i.test(file.name)) return false
  const loadId = state.loadId + 1
  set({ status: 'loading', fileName: `${file.name}, looking for it in Revit`, fileSize: file.size, loadId, error: undefined })
  const taken = await revitModelHook(file.name).catch(() => false)
  if (loadId !== state.loadId) return true // another file was opened meanwhile
  if (!taken) return false
  void state.source?.close()
  closeSession()
  closeContexts()
  resetLive()
  set({ status: 'empty', fileName: undefined, fileSize: undefined, pages: undefined, source: undefined, destroy: undefined, sheets: [], placements: [] })
  return true
}

/** Open a file the user picked or dropped: a PDF, a `.drawing`, or a Revit model (converted first). Swallows the error (it is shown inline). */
export async function openFile(file: OpenedFile): Promise<void> {
  if (/\.(rvt|rfa)$/i.test(file.name)) {
    if (await takeRevitModel(file)) return
    return openRevitModel(file)
  }
  await openDocument(file.bytes, file.name, { size: file.size, path: file.path }).catch(() => {})
}
