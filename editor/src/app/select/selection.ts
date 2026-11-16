/**
 * Selection and the type menu (docs/tasks/S1-select-and-retype.md).
 *
 * With the Select tool a click selects an element, Shift+click adds or removes one, and a right click (or the pen's
 * barrel button, in any tool) opens the type menu for the selection at the pointer. Two kinds of element:
 *  - drawn this session (an accepted decision, or plain markup ink): it can be read as another kind (the brush reads
 *    the stroke again with that kind forced) or given another type of its kind;
 *  - a host element of a `.drawing` / Revit sheet: it can be given another type of its category, which goes in the
 *    command log as a `set_type` (decision 0011) and is marked on the sheet until the linked model redraws it.
 * Every change from the menu is one undo step (StrokeHistory.replace).
 */
import { useSyncExternalStore } from 'react'
import type { AcceptedDecision, Command, DecisionKind, Point, SheetContext } from '@core/types'
import type { DrawingElement } from '@core/drawing'
import { categoryOf, ptPerMetre, withSessionElements } from '@core/context'
import { commandFromDecision } from '@core/commands'
import { StrokeSession } from '@core/predict'
import { nextCommandId, type Replacement } from '../board/history'
import { revitTypesOf } from './revitTypes'
import { getSession, session } from '../session'
import { getDocState } from '../store'
import { itemsOf } from '../drawing/inspect'
import { contextNow, emptyContext } from '../brain/contextStore'
import {
  CATEGORY_OF_KIND,
  READ_AS,
  documentTypes,
  revitOptions,
  mergeOptions,
  originalType,
  paletteOptions,
  sameSel,
  selKey,
  setTypeFor,
  sheetElementType,
  withType,
  type SelItem,
  type TypeOption,
} from './types'

// ───────────── store ─────────────

export interface SelectionState {
  items: readonly SelItem[]
  /** The type menu, open at a client point. */
  menu: { x: number; y: number } | null
  /** S2-07: the selection is being dragged by this sheet offset (drawn shifted until the drop). */
  drag: { dx: number; dy: number } | null
  /** S2-07: a short message about the last move or paste (a refused paste), shown for a few seconds. */
  notice: string | null
}

let state: SelectionState = { items: [], menu: null, drag: null, notice: null }
const listeners = new Set<() => void>()
function set(next: Partial<SelectionState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export const getSelection = (): SelectionState => state
export function subscribeSelection(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useSelection = (): SelectionState => useSyncExternalStore(subscribeSelection, getSelection)

export const selection = {
  /** Select just `item` (null clears). */
  select(item: SelItem | null) {
    const items = item ? [item] : []
    if (items.length === state.items.length && items.every((s, i) => sameSel(s, state.items[i]))) return
    set({ items })
  },
  /** Shift+click: add `item`, or take it out when it is already selected. */
  toggle(item: SelItem) {
    const has = state.items.some((s) => sameSel(s, item))
    set({ items: has ? state.items.filter((s) => !sameSel(s, item)) : [...state.items, item] })
  },
  has(item: SelItem): boolean {
    return state.items.some((s) => sameSel(s, item))
  },
  openMenu(at: { x: number; y: number }) {
    if (state.items.length) set({ menu: at })
  },
  /** Returns whether a menu was open. */
  closeMenu(): boolean {
    if (!state.menu) return false
    set({ menu: null })
    return true
  },
  /** Esc: close the menu, else drop the selection. Returns whether anything changed. */
  escape(): boolean {
    if (selection.closeMenu()) return true
    if (!state.items.length) return false
    set({ items: [] })
    return true
  },
  clear() {
    if (state.items.length || state.menu) set({ items: [], menu: null })
  },
  /** S2-07: the drag offset to draw the selection at (null when not dragging). */
  setDrag(drag: { dx: number; dy: number } | null) {
    if (drag === state.drag || (drag && state.drag && drag.dx === state.drag.dx && drag.dy === state.drag.dy)) return
    set({ drag })
  },
  /** S2-07: show a short message (cleared after a few seconds). */
  notice(text: string | null) {
    set({ notice: text })
    if (text && typeof setTimeout !== 'undefined') setTimeout(() => state.notice === text && set({ notice: null }), 4000)
  },
}

// ───────────── what is selected, resolved ─────────────

/** A selected item as the menu needs it. */
export type Resolved =
  | { t: 'drawn'; item: SelItem; strokeId: string; sheetId: string; decision: AcceptedDecision | null; kind: DecisionKind }
  | { t: 'sheet'; item: SelItem; id: string; sheetId: string; el: DrawingElement | undefined; category: string }

/** Element maps of every sheet of the open document (one per sheet; a `.drawing` shares one). */
function elementMaps(): Record<string, DrawingElement>[] {
  const { source, sheets } = getDocState()
  const out: Record<string, DrawingElement>[] = []
  for (const s of sheets) {
    const vp = source?.vectorPage?.(s.id)
    if (vp) out.push(vp.elements)
  }
  return out
}

/** The first sheet that draws host element `id`, and its element data. */
export function sheetOfElement(id: string): { sheetId: string; el: DrawingElement | undefined } | null {
  const { source, sheets } = getDocState()
  for (const s of sheets) {
    const vp = source?.vectorPage?.(s.id)
    if (vp && itemsOf(vp.page, [id]).length) return { sheetId: s.id, el: vp.elements[id] }
  }
  return null
}

/** The selection, resolved against the session and the document; items that are gone (undone, erased) drop out. */
export function resolveSelection(items: readonly SelItem[] = state.items): Resolved[] {
  const { accepted, strokes, hidden } = getSession()
  const out: Resolved[] = []
  for (const item of items) {
    if (item.t === 'drawn') {
      const stroke = strokes.find((s) => s.id === item.strokeId)
      if (!stroke || hidden.has(stroke.id)) continue
      const decision = accepted.find((d) => d.strokeId === item.strokeId) ?? null
      out.push({ t: 'drawn', item, strokeId: stroke.id, sheetId: stroke.sheetId, decision, kind: decision?.kind ?? 'markup' })
    } else {
      const at = sheetOfElement(item.id)
      if (at) out.push({ t: 'sheet', item, id: item.id, sheetId: at.sheetId, el: at.el, category: categoryOf(at.el) })
    }
  }
  return out
}

// ───────────── the menu's content ─────────────

export interface MenuModel {
  /** One line naming the selection ("Wall · Generic - 200mm", "Walls · 3 elements"). */
  title: string
  /** Read-as rows: only when every selected item was drawn. `current` is set when they all read the same. */
  readAs: { kinds: readonly DecisionKind[]; current: DecisionKind | null } | null
  /** Type rows, when the selection shares one category. `current` is the label they all have, if one. */
  types: { category: string; options: TypeOption[]; current: string | null; original: string | null } | null
  /** Why there are no type rows, when there are none. */
  note?: string
  count: number
}

const KIND_WORD: Record<DecisionKind, string> = { wall: 'Wall', door: 'Door', furniture: 'Furniture', delete: 'Delete', markup: 'Markup' }

/** The category a resolved item's types come from, or null when it has no types (markup). */
const categoryKey = (r: Resolved): string | null => (r.t === 'drawn' ? (CATEGORY_OF_KIND[r.kind] ?? null) : r.category || null)

function currentLabel(r: Resolved, commands: readonly Command[]): string | null {
  if (r.t === 'drawn') return r.decision?.type ?? null
  return sheetElementType(r.id, r.el, commands)?.label ?? null
}

export function menuModel(rs: readonly Resolved[] = resolveSelection()): MenuModel | null {
  if (!rs.length) return null
  const { commands } = getSession()
  const palette = getDocState().source?.palette
  const allDrawn = rs.every((r) => r.t === 'drawn')
  const kinds = new Set(rs.map((r) => (r.t === 'drawn' ? r.kind : null)))
  const readAs = allDrawn ? { kinds: READ_AS, current: kinds.size === 1 ? ([...kinds][0] as DecisionKind) : null } : null

  const cats = new Set(rs.map(categoryKey))
  let types: MenuModel['types'] = null
  let note: string | undefined
  if (cats.size === 1 && [...cats][0]) {
    const category = [...cats][0]!
    const kind = (Object.keys(CATEGORY_OF_KIND) as DecisionKind[]).find((k) => CATEGORY_OF_KIND[k] === category)
    const lists: TypeOption[][] = []
    if (rs.some((r) => r.t === 'drawn') && kind && palette) lists.push(paletteOptions(palette, kind))
    if (rs.some((r) => r.t === 'sheet')) {
      const doc = documentTypes(elementMaps(), category)
      // S1-07: one host element of a linked sheet: every type Revit allows for it first, then the document's
      const one = rs.length === 1 && rs[0].t === 'sheet' ? rs[0] : null
      const fromRevit = one ? revitTypesOf(one.sheetId, one.id) : undefined
      if (fromRevit?.types.length) lists.push(revitOptions(doc, fromRevit.types))
      lists.push(doc)
    }
    const options = mergeOptions(...lists)
    const labels = new Set(rs.map((r) => currentLabel(r, commands)))
    const current = labels.size === 1 ? [...labels][0] : null
    const originals = new Set(rs.map((r) => (r.t === 'sheet' ? (originalType(r.el)?.label ?? null) : null)))
    const original = rs.every((r) => r.t === 'sheet') && originals.size === 1 ? [...originals][0] : null
    // the current type is always offered, even when the lists do not name it
    if (current && !options.some((o) => o.label === current)) options.unshift({ label: current, typeName: current })
    if (options.length) types = { category, options, current, original }
    else note = `No other ${category.toLowerCase()} types in this drawing`
  } else if (cats.size > 1) note = 'Select elements of one category to change their type'
  else if (!allDrawn) note = 'This element has no type'

  const one = rs.length === 1 ? rs[0] : null
  let title: string
  if (one) {
    const what = one.t === 'drawn' ? KIND_WORD[one.kind] : one.el?.name || one.category || 'Element'
    const type = currentLabel(one, commands)
    title = type ? `${what} · ${type}` : what
  } else {
    const what = cats.size === 1 && [...cats][0] ? [...cats][0] : allDrawn && kinds.size === 1 ? KIND_WORD[[...kinds][0] as DecisionKind] : 'Mixed'
    title = `${what} · ${rs.length} elements`
  }
  return { title, readAs, types, note, count: rs.length }
}

// ───────────── applying a choice ─────────────

const scaleOf = (sheetId: string): number | undefined => {
  const ctx = contextNow(sheetId)
  const s = ctx?.scale ?? getDocState().sheets.find((x) => x.id === sheetId)?.scale
  return s && s > 0 ? s : undefined
}

/** The sheet's context with this session's elements laid over it, leaving out the commands of `strokeIds`. */
function contextWithout(sheetId: string, strokeIds: ReadonlySet<string>): SheetContext {
  const s = getSession()
  const commands = s.commands.filter((c) => !strokeIds.has(c.strokeId))
  return withSessionElements(contextNow(sheetId) ?? emptyContext(sheetId), commands, { palette: getDocState().source?.palette, skipStrokes: s.hidden })
}

/** Command ids handed out in order, so a batch never reuses one. */
function idMaker() {
  const { commands, commandPrefix, commandSeq } = getSession()
  const log: Command[] = commands.slice()
  return (cmd: (id: string) => Command | null): Command | null => {
    const c = cmd(nextCommandId(log, commandPrefix, commandSeq))
    if (c) log.push(c)
    return c
  }
}

const ownCommand = (strokeId: string): Command | null => getSession().commands.find((c) => c.strokeId === strokeId && c.op !== 'set_type') ?? null

/** Read the selected drawn elements as `kind` (markup: they go back to plain ink). One undo step. */
export function setKind(kind: DecisionKind, rs: readonly Resolved[] = resolveSelection()): void {
  const s = getSession()
  const palette = getDocState().source?.palette
  const next = idMaker()
  const changes: Replacement[] = []
  for (const r of rs) {
    if (r.t !== 'drawn' || r.kind === kind) continue
    const before = { decision: r.decision, command: ownCommand(r.strokeId) }
    if (kind === 'markup') {
      changes.push({ before, after: {} })
      continue
    }
    const stroke = s.strokes.find((x) => x.id === r.strokeId)
    if (!stroke || stroke.points.length < 2) continue
    const ctx = contextWithout(r.sheetId, new Set([r.strokeId]))
    const history = s.accepted.filter((d) => d.strokeId !== r.strokeId)
    const read = new StrokeSession(stroke, ctx, { ...s.settings, mode: kind }, { history, palette })
    read.end()
    const d = { ...read.commit(Date.now()), kind }
    // keep how sure the brush was about this kind when it first read the stroke, when it said
    if (r.decision) d.confidence = r.decision.confidence
    changes.push({ before, after: { decision: d, command: next((id) => commandFromDecision(d, id, ctx)) } })
  }
  session.replaceElements(changes)
}

/** Give the selected elements type `opt` (drawn ones of the matching kind, and host elements). One undo step. */
export function setType(opt: TypeOption, rs: readonly Resolved[] = resolveSelection()): void {
  const s = getSession()
  const palette = getDocState().source?.palette
  const next = idMaker()
  const changes: Replacement[] = []
  for (const r of rs) {
    if (r.t === 'drawn') {
      if (!r.decision || !palette || r.decision.type === opt.label) continue
      const scale = scaleOf(r.sheetId)
      const d = withType(r.decision, opt.label, palette, scale ? ptPerMetre(scale) : undefined)
      const ctx = contextWithout(r.sheetId, new Set([r.strokeId]))
      changes.push({ before: { decision: r.decision, command: ownCommand(r.strokeId) }, after: { decision: d, command: next((id) => commandFromDecision(d, id, ctx)) } })
    } else {
      const pending = setTypeFor(s.commands, r.id) ?? null
      const now = sheetElementType(r.id, r.el, s.commands)
      if (now?.label === opt.label) continue
      // the type the drawing already has: just drop the pending change
      if (originalType(r.el)?.label === opt.label) {
        if (pending) changes.push({ before: { command: pending }, after: {} })
        continue
      }
      // the document's own name for a type picked from the palette, when it has one
      const doc = documentTypes(elementMaps(), r.category).find((o) => o.label === opt.label) ?? opt
      const cmd = next((id) => {
        const c: Command = { op: 'set_type', id, sheetId: r.sheetId, targets: [r.id], typeName: doc.typeName, strokeId: `type:${r.id}` }
        if (doc.family) c.family = doc.family
        return c
      })
      changes.push({ before: { command: pending }, after: { command: cmd } })
    }
  }
  session.replaceElements(changes)
}

// ───────────── helpers for the board ─────────────

/** Centre of host element `elementId`'s items on `sheetId`, in sheet points (Revit result pins, type markers). */
export function elementAnchor(sheetId: string, elementId: string | undefined): Point | null {
  if (!elementId) return null
  const vp = getDocState().source?.vectorPage?.(sheetId)
  if (!vp) return null
  const b = elementBox(itemsOf(vp.page, [elementId]))
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null
}

/** Bounding box of drawing items, in sheet points. */
export function elementBox(items: ReturnType<typeof itemsOf>): { x: number; y: number; w: number; h: number } | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const add = (xy: ArrayLike<number>) => {
    for (let k = 0; k + 1 < xy.length; k += 2) {
      x0 = Math.min(x0, xy[k])
      x1 = Math.max(x1, xy[k])
      y0 = Math.min(y0, xy[k + 1])
      y1 = Math.max(y1, xy[k + 1])
    }
  }
  for (const it of items) {
    if (it.t === 'path' || it.t === 'segs') add(it.xy)
    else if (it.t === 'fill') it.rings.forEach(add)
    else if (it.t === 'image') add([it.rect.x, it.rect.y, it.rect.x + it.rect.w, it.rect.y + it.rect.h])
    else if (it.t === 'text') add([it.at.x, it.at.y])
  }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

export { selKey }
