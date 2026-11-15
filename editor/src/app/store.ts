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
import { DrawingFileSource, openSource, type DrawingSource, type PageRenderer } from './source'
import { resetLive } from './brain/live'

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
  set({ status: 'loading', fileName, fileSize: size, loadId, error: undefined })
  let source: DrawingSource | undefined
  try {
    // copy: pdf.js may transfer (detach) the buffer it is given
    const bytes = typeof input === 'string' ? null : input instanceof Uint8Array ? input.slice() : new Uint8Array(input.slice(0))
    // own copy for the context worker: PdfDrawingSource hands the same buffer to pdf.js, which detaches it
    const ctxBytes = bytes?.slice()
    source = await openSource(bytes ? { name: fileName, bytes } : (input as string))
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
      fileName: source.name,
      pages: pages ?? undefined,
      source,
      sheets,
      placements: layoutSheets(sheets),
      destroy: () => source!.close(),
    })
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
    void prev?.close()
    closeSession()
    closeContexts()
    resetLive()
    const msg = (e as Error).message ?? String(e)
    const error = /not a PDF/i.test(msg)
      ? `“${fileName}” is not a PDF or a .drawing package. Choose a .pdf or .drawing file.`
      : `Could not read “${fileName}”. It may be damaged. (${msg})`
    set({ status: 'error', pages: undefined, source: undefined, destroy: undefined, sheets: [], placements: [], error })
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
  set({ status: 'loading', fileName: source.name, fileSize: opts.size ?? 0, loadId, error: undefined })
  const { sheets, pages } = await source.load()
  if (loadId !== state.loadId) return loadId
  if (prev && prev !== source) void prev.close()
  resetLive()
  await openEphemeralSession()
  set({
    status: 'ready',
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
  const { sheets, pages } = await source.load()
  if (state.source !== source) return
  const old = new Map(state.placements.map((p) => [p.sheetId, p]))
  const placements = layoutSheets(sheets).map((p) => {
    const o = old.get(p.sheetId)
    return o && samePlacement(o, p) ? o : p
  })
  set({ sheets, placements, pages: pages ?? undefined })
  refreshContexts(sheets.map((s) => s.id), changed)
}

/** Open a file the user picked or dropped. Swallows the error (it is shown inline). */
export async function openFile(file: OpenedFile): Promise<void> {
  await openDocument(file.bytes, file.name, { size: file.size, path: file.path }).catch(() => {})
}
