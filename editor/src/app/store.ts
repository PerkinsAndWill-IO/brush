/**
 * M0 document store: a tiny external store shared by the React tree and the
 * test API. The canvas lane is expected to replace/extend this in M1.
 */
import { useSyncExternalStore } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Sheet } from '@core/types'
import { loadPdf, type PdfSource } from './pdf/pdfjs'

export type DocStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface DocState {
  status: DocStatus
  fileName?: string
  doc?: PDFDocumentProxy
  destroy?: () => Promise<void>
  sheets: Sheet[]
  error?: string
  /** Bumped per load so views can re-render pages. */
  loadId: number
}

let state: DocState = { status: 'empty', sheets: [], loadId: 0 }
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

/** Open a PDF. Errors keep the empty state and set `error` (M1-02). */
export async function openDocument(src: PdfSource, fileName: string): Promise<number> {
  const loadId = state.loadId + 1
  const prev = state.destroy
  set({ status: 'loading', fileName, loadId, error: undefined })
  try {
    const { doc, sheets, destroy } = await loadPdf(src)
    void prev?.()
    set({ status: 'ready', doc, sheets, destroy })
    return loadId
  } catch (e) {
    void prev?.()
    set({ status: 'error', doc: undefined, destroy: undefined, sheets: [], error: `Could not read ${fileName}: ${(e as Error).message}` })
    throw e
  }
}
