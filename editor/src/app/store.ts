/**
 * Document store: the open PDF and its sheets, shared by the React tree and
 * the test API. Opening binds the stroke session to the PDF's sidecar.
 */
import { useSyncExternalStore } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Sheet } from '@core/types'
import { layoutSheets, type Placement } from './board/layout'
import { loadPdf, type PdfSource } from './pdf/pdfjs'
import type { OpenedFile } from './platform'
import { closeSession, openSession } from './session'

export type DocStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface DocState {
  status: DocStatus
  fileName?: string
  fileSize?: number
  doc?: PDFDocumentProxy
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

/** Open a PDF. Errors keep the empty state and set `error` (M1-02). */
export async function openDocument(src: PdfSource, fileName: string, opts: OpenOptions = {}): Promise<number> {
  const loadId = state.loadId + 1
  const prev = state.destroy
  const size = opts.size ?? (typeof src === 'string' ? 0 : src.byteLength)
  set({ status: 'loading', fileName, fileSize: size, loadId, error: undefined })
  try {
    if (typeof src !== 'string' && !looksLikePdf(fileName, src)) {
      throw new Error(`“${fileName}” is not a PDF. Choose a .pdf file.`)
    }
    const { doc, sheets, destroy } = await loadPdf(src)
    if (sheets.length === 0) throw new Error(`“${fileName}” has no pages.`)
    void prev?.()
    await openSession({ name: fileName, size, path: opts.path }, sheets.map((s) => s.id))
    set({ status: 'ready', doc, sheets, placements: layoutSheets(sheets), destroy })
    return loadId
  } catch (e) {
    void prev?.()
    closeSession()
    const msg = (e as Error).message ?? String(e)
    const error = msg.startsWith('“') ? msg : `Could not read “${fileName}”. It may be damaged or not a PDF. (${msg})`
    set({ status: 'error', doc: undefined, destroy: undefined, sheets: [], placements: [], error })
    throw e
  }
}

/** Open a file the user picked or dropped. Swallows the error (it is shown inline). */
export async function openFile(file: OpenedFile): Promise<void> {
  await openDocument(file.bytes, file.name, { size: file.size, path: file.path }).catch(() => {})
}
