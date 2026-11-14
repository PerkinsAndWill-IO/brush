/**
 * Inspecting host elements on `.drawing` sheets (docs/tasks/V3-inspect.md), as in the schema viewer: with the Select
 * tool, hovering an item highlights its element on every sheet it appears on and shows its data in the
 * Select tool's sidebar panel; a click pins it. A tag resolves to the element it labels (both are highlighted).
 *
 * Elements are shared by all pages of a document (and Revit ids are shared by every linked sheet), so "the same
 * element on another sheet" is simply the items with the same `el`.
 */
import { useSyncExternalStore } from 'react'
import type { DrawingElement, DrawingPage, DrawItem } from '@core/drawing'
import { buildPageHitIndex, hitItem, pageHitIndexSteps, type Measure, type PageHitIndex } from './hit'

// ───────────── element card logic (pure) ─────────────

/** "RoomTag" -> "Room tag". */
export function classLabel(cls: string): string {
  const s = cls.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** "SNAKE_CASE" -> "Snake case". Names that are not all caps and underscores pass through. */
export function paramLabel(name: string): string {
  if (!/^[A-Z0-9_]+$/.test(name)) return name
  const n = name.replace(/_+/g, ' ').trim().toLowerCase()
  return n.charAt(0).toUpperCase() + n.slice(1)
}

/** Card category line: category, else class. */
export function cardCategory(info: DrawingElement | undefined): string {
  return info?.category || (info?.class ? classLabel(info.class) : '') || 'Element'
}

export interface Resolved {
  /** Element whose card is shown (the tagged element for a tag). */
  id: string
  info: DrawingElement | undefined
  /** Set when the hovered element is a tag: its class as words. */
  tagLabel: string | null
  /** Elements whose items are highlighted: the hovered one first, then the tagged one. */
  highlight: string[]
}

export function resolveElement(elements: Record<string, DrawingElement>, id: string): Resolved {
  const own = elements[id]
  const tagged = own?.tagged != null ? String(own.tagged) : null
  const target = tagged !== null ? elements[tagged] : undefined
  if (!own || tagged === null || !target) return { id, info: own, tagLabel: null, highlight: [id] }
  return { id: tagged, info: target, tagLabel: classLabel(own.class ?? 'Tag'), highlight: [id, tagged] }
}

// ───────────── per-page caches ─────────────

const byElementCache = new WeakMap<DrawingPage, Map<string, number[]>>()

/** Item indices per element id on a page. */
export function itemsByElement(page: DrawingPage): Map<string, number[]> {
  let m = byElementCache.get(page)
  if (!m) {
    m = new Map()
    page.items.forEach((it, i) => {
      if (it.el === null) return
      const list = m!.get(it.el)
      if (list) list.push(i)
      else m!.set(it.el, [i])
    })
    byElementCache.set(page, m)
  }
  return m
}

/** Items of `ids` on a page, in draw order. */
export function itemsOf(page: DrawingPage, ids: readonly string[]): DrawItem[] {
  const by = itemsByElement(page)
  const idx = ids.flatMap((id) => by.get(id) ?? [])
  if (ids.length > 1) idx.sort((a, b) => a - b)
  return idx.map((i) => page.items[i])
}

const hitCache = new WeakMap<DrawingPage, PageHitIndex>()
let measureCtx: CanvasRenderingContext2D | null | undefined

/** Text widths from a canvas with the renderer's font, so text boxes match what is drawn. */
const canvasMeasure: Measure = (text, em, bold) => {
  if (measureCtx === undefined) measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null
  if (!measureCtx) return text.length * em * 0.53
  measureCtx.font = `${bold ? 'bold ' : ''}${em}px Arial, sans-serif`
  return measureCtx.measureText(text).width
}

export function pageHitIndex(page: DrawingPage): PageHitIndex {
  let ix = hitCache.get(page)
  if (!ix) hitCache.set(page, (ix = buildPageHitIndex(page, canvasMeasure)))
  return ix
}

// Large sheets (millions of segments) take about a second to index: warming builds the index of each page in
// slices of a few milliseconds between timer ticks, so the first hover never freezes the board.
const SLICE_MS = 8
const warmQueue: DrawingPage[] = []
let warming = false
const readyListeners = new Set<() => void>()

/** Called whenever a page's hit index has just been built in the background (so a still pointer can look again). */
export function onHitIndexReady(l: () => void): () => void {
  readyListeners.add(l)
  return () => readyListeners.delete(l)
}

/** Index `pages` in the background, one after the other (pages already indexed are skipped). */
export function warmHitIndexes(pages: readonly (DrawingPage | undefined | null)[]) {
  for (const p of pages) if (p && !hitCache.has(p) && !warmQueue.includes(p)) warmQueue.push(p)
  if (warming || warmQueue.length === 0) return
  warming = true
  const run = () => {
    const page = warmQueue[0]
    if (!page) {
      warming = false
      return
    }
    if (hitCache.has(page)) {
      warmQueue.shift()
      return run()
    }
    const steps = pageHitIndexSteps(page, canvasMeasure)
    const slice = () => {
      const until = performance.now() + SLICE_MS
      for (;;) {
        const r = steps.next()
        if (r.done) {
          if (!hitCache.has(page)) hitCache.set(page, r.value) // a hover may have built it synchronously meanwhile
          warmQueue.shift()
          readyListeners.forEach((l) => l())
          return setTimeout(run, 0)
        }
        if (performance.now() > until) return setTimeout(slice, 0)
      }
    }
    slice()
  }
  setTimeout(run, 0)
}

/** Like `elementAt`, but never builds the index on the spot: while a page is still being indexed it answers null. */
export function elementAtIfReady(page: DrawingPage, x: number, y: number, tol: number, skip?: ((it: DrawItem) => boolean) | null): string | null {
  if (!hitCache.has(page)) {
    warmHitIndexes([page])
    return null
  }
  return elementAt(page, x, y, tol, skip)
}

/** Element id under (x, y) sheet points, or null. Hidden items (display filters) are skipped. */
export function elementAt(page: DrawingPage, x: number, y: number, tol: number, skip?: ((it: DrawItem) => boolean) | null): string | null {
  const i = hitItem(pageHitIndex(page), x, y, tol, skip)
  return i < 0 ? null : page.items[i].el
}

// ───────────── store ─────────────

export interface InspectState {
  /** Element under the pointer (Select tool), or null. */
  hover: string | null
  /** Element pinned by a click, or null. While pinned, hover does not change what is shown. */
  pinned: string | null
}

let state: InspectState = { hover: null, pinned: null }
const listeners = new Set<() => void>()
function set(next: Partial<InspectState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export const getInspect = (): InspectState => state
export function subscribeInspect(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useInspect = (): InspectState => useSyncExternalStore(subscribeInspect, getInspect)

/** The element the panel and the highlight show: the pinned one, else the hovered one. */
export const shownElement = (s: InspectState = state): string | null => s.pinned ?? s.hover

export const inspect = {
  hover(id: string | null) {
    if (state.pinned !== null || id === state.hover) return
    set({ hover: id })
  },
  pin(id: string) {
    set({ pinned: id, hover: id })
  },
  /** Release the pinned element (Esc, a click on empty paper). Returns whether one was pinned. */
  unpin(): boolean {
    const had = state.pinned !== null
    if (had || state.hover !== null) set({ pinned: null, hover: null })
    return had
  },
  clear() {
    if (state.pinned !== null || state.hover !== null) set({ pinned: null, hover: null })
  },
}
