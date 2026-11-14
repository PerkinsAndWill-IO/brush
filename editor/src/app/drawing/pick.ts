/**
 * Picking elements on a `.drawing` page with the Select tool: which element is under the pointer, and the hover /
 * pinned state the card and the highlight layer show. The hit index of a page is built once, in slices of a few
 * milliseconds so the board keeps answering (a KRO sheet has millions of segments), the first time the Select tool
 * is used there. Nothing here is written to the sidecar or the command log: picking is a view aid.
 */
import { useSyncExternalStore } from 'react'
import { hitIndexSteps, hitTest, resolveElement, type DrawingDocument, type DrawingPage, type HitIndex, type Measure } from '@core/drawing'
import type { Point } from '@core/types'
import { getSession, subscribeSession } from '../session'
import { DrawingFileSource } from '../source'
import { getDocState } from '../store'
import { hiddenPredicate } from './filters'

/** The page and the document of a sheet, or null for a PDF. */
export function drawingPageOf(sheetId: string): { doc: DrawingDocument; page: DrawingPage } | null {
  const { source, sheets } = getDocState()
  const sheet = sheets.find((s) => s.id === sheetId)
  if (!sheet || !(source instanceof DrawingFileSource)) return null
  const page = source.doc.pages[sheet.pageIndex]
  return page ? { doc: source.doc, page } : null
}

// ───────────── hit index per page ─────────────

let ctx: CanvasRenderingContext2D | null = null
let font = ''
/** Text widths from a canvas at 100 px, scaled to the em size (as the schema viewer measures). */
const measure: Measure = (text, em, bold) => {
  ctx ??= document.createElement('canvas').getContext('2d')!
  const f = `${bold ? 'bold ' : ''}100px Arial, sans-serif`
  if (f !== font) ctx.font = font = f
  return (ctx.measureText(text).width / 100) * em
}

/** Longest stretch of index building between two yields to the browser. */
const SLICE_MS = 8

interface Entry {
  index: HitIndex | null
  ready: Promise<HitIndex>
  /** Milliseconds of work to build it (not counting the waits between slices). */
  buildMs: number
}
const entries = new WeakMap<DrawingPage, Entry>()

/** Build the index in slices, giving the thread back to the browser between them. */
async function build(page: DrawingPage, entry: Entry): Promise<HitIndex> {
  const steps = hitIndexSteps(page, measure)
  for (;;) {
    const t0 = performance.now()
    while (performance.now() - t0 < SLICE_MS) {
      const r = steps.next()
      if (!r.done) continue
      entry.buildMs += performance.now() - t0
      return (entry.index = r.value)
    }
    entry.buildMs += performance.now() - t0
    await new Promise((resolve) => setTimeout(resolve))
  }
}

function entryFor(page: DrawingPage): Entry {
  let e = entries.get(page)
  if (!e) {
    e = { index: null, buildMs: 0 } as Entry // `ready` is set on the next line
    e.ready = build(page, e)
    entries.set(page, e)
  }
  return e
}

/** The built index of the sheet's page, or null while it is still being built (the build starts if it has not). */
export function hitIndexOf(sheetId: string): HitIndex | null {
  const p = drawingPageOf(sheetId)
  return p ? entryFor(p.page).index : null
}

/** Resolves when the sheet's hit index is built (immediately for a PDF). */
export async function hitIndexReady(sheetId: string): Promise<void> {
  const p = drawingPageOf(sheetId)
  if (p) await entryFor(p.page).ready
}

/** Dev/test: milliseconds of work the sheet's hit index took to build; -1 if it is not built. */
export function indexBuildMs(sheetId: string): number {
  const p = drawingPageOf(sheetId)
  const e = p && entries.get(p.page)
  return e?.index ? e.buildMs : -1
}

/**
 * The element under a point of the sheet, `null` for empty paper (or a PDF), `undefined` while the sheet's hit index is
 * still being built. `tol` is the pick radius in sheet points.
 */
export function elementAt(sheetId: string, p: Point, tol: number): string | null | undefined {
  const d = drawingPageOf(sheetId)
  if (!d) return null
  const index = entryFor(d.page).index
  if (!index) return undefined
  const hit = hitTest(index, p.x, p.y, tol, hiddenPredicate(d.doc))
  return hit < 0 ? null : d.page.items[hit].el
}

/** Items to highlight for an element of a sheet: all of its items on the page, and the tagged element's for a tag. */
export function itemsOfElement(sheetId: string, el: string): readonly number[] {
  const d = drawingPageOf(sheetId)
  const index = d && entryFor(d.page).index
  if (!d || !index) return []
  const hide = hiddenPredicate(d.doc)
  return resolveElement(d.doc.elements, el)
    .highlight.flatMap((id) => index.byElement.get(id) ?? [])
    .filter((i) => !hide?.(d.page.items[i]))
}

// ───────────── hover / pinned state ─────────────

export interface Picked {
  sheetId: string
  /** Element id (a key of the document's `elements`). */
  el: string
  /** Pointer position in the board viewport, CSS px (where the card goes). */
  x: number
  y: number
}

export interface PickState {
  hover: Picked | null
  pinned: Picked | null
}

let state: PickState = { hover: null, pinned: null }
const listeners = new Set<() => void>()
function emit(next: Partial<PickState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export const getPick = (): PickState => state
export const activePick = (): Picked | null => state.pinned ?? state.hover
export function subscribePick(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const usePick = (): PickState => useSyncExternalStore(subscribePick, getPick)

const same = (a: Picked | null, b: Picked | null) => a === b || (!!a && !!b && a.sheetId === b.sheetId && a.el === b.el && a.x === b.x && a.y === b.y)

export const pick = {
  /** The element under the pointer (null = none). Ignored while a card is pinned. */
  hover(p: Picked | null) {
    if (state.pinned || same(state.hover, p)) return
    emit({ hover: p })
  },
  pin(p: Picked) {
    emit({ pinned: p, hover: p })
  },
  /** Drop the pinned card; true if there was one. */
  unpin(): boolean {
    const had = state.pinned !== null
    if (had || state.hover) emit({ pinned: null, hover: null })
    return had
  },
  clear() {
    pick.unpin()
  },
}

// Picking belongs to the Select tool: leaving it drops the card, and choosing it starts indexing the pages.
let wasSelect = false
subscribeSession(() => {
  const isSelect = getSession().tool === 'select'
  if (isSelect === wasSelect) return
  wasSelect = isSelect
  if (!isSelect) return pick.clear()
  void (async () => {
    for (const s of getDocState().sheets) {
      await hitIndexReady(s.id)
      if (getSession().tool !== 'select') return
    }
  })()
})
