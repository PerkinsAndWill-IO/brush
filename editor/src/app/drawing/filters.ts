/**
 * Display filters for `.drawing` pages (docs/tasks/V2-drawing-filters.md): hide whole categories (Dimensions, Grids,
 * Furniture, ...) or whole item kinds (fills, text, ...) to cut the noise on busy sheets.
 *
 * Display only: hidden items still feed the sheet context (snapping, predictions), and nothing is written to the
 * sidecar or the command log. Choices are remembered per browser by category name, so they carry across files.
 */
import { useSyncExternalStore } from 'react'
import { classLabel, type DrawingDocument, type DrawingElement, type DrawItem } from '@core/drawing'

export type ItemKind = 'lines' | 'fills' | 'text' | 'images'

export const ITEM_KINDS: readonly { kind: ItemKind; label: string }[] = [
  { kind: 'lines', label: 'Lines' },
  { kind: 'fills', label: 'Fills' },
  { kind: 'text', label: 'Text' },
  { kind: 'images', label: 'Images' },
]

/** Label for items that belong to no element. */
export const NO_CATEGORY = 'No category'

export function kindOf(it: DrawItem): ItemKind {
  return it.t === 'fill' ? 'fills' : it.t === 'text' ? 'text' : it.t === 'image' ? 'images' : 'lines'
}

/** The element's category, else its class, else NO_CATEGORY. */
export function categoryName(el: DrawingElement | undefined): string {
  return el?.category || (el?.class ? classLabel(el.class) : '') || NO_CATEGORY
}

export function itemCategory(doc: Pick<DrawingDocument, 'elements'>, it: DrawItem): string {
  return categoryName(it.el === null ? undefined : doc.elements[it.el])
}

export interface CategoryCount {
  name: string
  count: number
}

/** Categories present in a document with their item counts, most items first (ties by name). */
export function categoriesOf(doc: Pick<DrawingDocument, 'elements' | 'pages'>): CategoryCount[] {
  const counts = new Map<string, number>()
  for (const p of doc.pages) for (const it of p.items) {
    const c = itemCategory(doc, it)
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Categories that are annotation rather than model: one click hides them all. */
const ANNOTATION = /dim|tag|text|note|grid|level|section|elevation|title ?block|viewport|schedule|legend|callout|keynote|symbol|reference|revision|matchline|scope box|view/i
export const isAnnotationCategory = (name: string): boolean => ANNOTATION.test(name)

export interface FilterState {
  hiddenCategories: ReadonlySet<string>
  hiddenKinds: ReadonlySet<ItemKind>
  /** Bumped on every change: pages re-render when it moves. */
  version: number
}

const STORAGE_KEY = 'brush.filters.v1'

function load(): Pick<FilterState, 'hiddenCategories' | 'hiddenKinds'> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    const p = raw ? (JSON.parse(raw) as { categories?: unknown; kinds?: unknown }) : {}
    const cats = Array.isArray(p.categories) ? p.categories.filter((c): c is string => typeof c === 'string') : []
    const kinds = Array.isArray(p.kinds) ? p.kinds.filter((k): k is ItemKind => ITEM_KINDS.some((o) => o.kind === k)) : []
    return { hiddenCategories: new Set(cats), hiddenKinds: new Set(kinds) }
  } catch {
    return { hiddenCategories: new Set(), hiddenKinds: new Set() }
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ categories: [...state.hiddenCategories], kinds: [...state.hiddenKinds] }))
  } catch {
    /* storage unavailable: filters last for this page only */
  }
}

let state: FilterState = { ...load(), version: 0 }
const listeners = new Set<() => void>()

function emit(next: Partial<Pick<FilterState, 'hiddenCategories' | 'hiddenKinds'>>) {
  state = { ...state, ...next, version: state.version + 1 }
  save()
  listeners.forEach((l) => l())
}

export const getFilters = (): FilterState => state
export function subscribeFilters(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useFilters = (): FilterState => useSyncExternalStore(subscribeFilters, getFilters)

const toggled = <T,>(set: ReadonlySet<T>, v: T, hidden: boolean): Set<T> => {
  const next = new Set(set)
  if (hidden) next.add(v)
  else next.delete(v)
  return next
}

export const filters = {
  setCategoryHidden(name: string, hidden: boolean) {
    if (state.hiddenCategories.has(name) !== hidden) emit({ hiddenCategories: toggled(state.hiddenCategories, name, hidden) })
  },
  setKindHidden(kind: ItemKind, hidden: boolean) {
    if (state.hiddenKinds.has(kind) !== hidden) emit({ hiddenKinds: toggled(state.hiddenKinds, kind, hidden) })
  },
  /** Hide (or show) several categories at once. */
  setCategoriesHidden(names: readonly string[], hidden: boolean) {
    const next = new Set(state.hiddenCategories)
    for (const n of names) {
      if (hidden) next.add(n)
      else next.delete(n)
    }
    emit({ hiddenCategories: next })
  },
  /** Show everything again. */
  reset() {
    if (state.hiddenCategories.size || state.hiddenKinds.size) emit({ hiddenCategories: new Set(), hiddenKinds: new Set() })
  },
}

/** Predicate for the renderer: true when the item is filtered out. Null when nothing is hidden. */
export function hiddenPredicate(doc: Pick<DrawingDocument, 'elements'>, f: FilterState = state): ((it: DrawItem) => boolean) | null {
  if (!f.hiddenCategories.size && !f.hiddenKinds.size) return null
  return (it) => f.hiddenKinds.has(kindOf(it)) || (f.hiddenCategories.size > 0 && f.hiddenCategories.has(itemCategory(doc, it)))
}
