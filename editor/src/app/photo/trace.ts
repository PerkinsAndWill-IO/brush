/**
 * Trace paper (P1-10): after a photo import, a roll of trace paper unrolls over the sheet the markup landed on, and
 * the imported strokes sit on it, the way they were drawn. Its opacity is a slider; rolling it up leaves the strokes.
 *
 * State only, per sheet. The layer is ./TracePaper.tsx (inside each sheet), the control floats over the board.
 * Not saved with the drawing: it is a view of the photo strokes, like the display filters.
 */
import { useSyncExternalStore } from 'react'
import { getSession, subscribeSession } from '../session'
import { photoGroupOf } from './groups'

export type TracePhase = 'unrolling' | 'shown' | 'rolling'

export interface SheetTrace {
  sheetId: string
  phase: TracePhase
  /** Bumped on every unroll / roll up, so the CSS animation restarts. */
  run: number
}

/** Unroll and roll-up durations (ms). The CSS reads them as custom properties. */
export const UNROLL_MS = 1700
export const ROLL_UP_MS = 1100
const OPACITY_KEY = 'brush.trace.opacity'
export const DEFAULT_OPACITY = 0.6

interface TraceStore {
  sheets: ReadonlyMap<string, SheetTrace>
  /** 0..1, shared by every sheet (the slider). */
  opacity: number
}

function loadOpacity(): number {
  try {
    const v = Number(globalThis.localStorage?.getItem(OPACITY_KEY))
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : DEFAULT_OPACITY
  } catch {
    return DEFAULT_OPACITY
  }
}

let store: TraceStore = { sheets: new Map(), opacity: loadOpacity() }
let run = 0
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const listeners = new Set<() => void>()

function emit(next: Partial<TraceStore>) {
  store = { ...store, ...next }
  listeners.forEach((l) => l())
}

function put(sheetId: string, t: SheetTrace | null) {
  const sheets = new Map(store.sheets)
  if (t) sheets.set(sheetId, t)
  else sheets.delete(sheetId)
  emit({ sheets })
}

function after(sheetId: string, ms: number, fn: () => void) {
  clearTimeout(timers.get(sheetId))
  timers.set(sheetId, setTimeout(() => (timers.delete(sheetId), fn()), ms))
}

const reducedMotion = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Does the sheet hold strokes from a photo import? */
export const sheetHasPhotoInk = (sheetId: string): boolean => getSession().strokes.some((s) => s.sheetId === sheetId && !!photoGroupOf(s.id))

export const tracePaper = {
  /** Unroll the trace over a sheet (again, if it is rolling up). */
  unroll(sheetId: string) {
    const cur = store.sheets.get(sheetId)
    if (cur && cur.phase !== 'rolling') return
    const still = reducedMotion()
    put(sheetId, { sheetId, phase: still ? 'shown' : 'unrolling', run: ++run })
    if (!still) after(sheetId, UNROLL_MS, () => store.sheets.get(sheetId)?.phase === 'unrolling' && put(sheetId, { ...store.sheets.get(sheetId)!, phase: 'shown' }))
  },
  /** Roll it back up; the strokes stay on the sheet. */
  rollUp(sheetId: string) {
    const cur = store.sheets.get(sheetId)
    if (!cur || cur.phase === 'rolling') return
    if (reducedMotion()) {
      clearTimeout(timers.get(sheetId))
      put(sheetId, null)
      return
    }
    put(sheetId, { sheetId, phase: 'rolling', run: ++run })
    after(sheetId, ROLL_UP_MS, () => store.sheets.get(sheetId)?.phase === 'rolling' && put(sheetId, null))
  },
  setOpacity(v: number) {
    const opacity = Math.min(1, Math.max(0, v))
    emit({ opacity })
    try {
      globalThis.localStorage?.setItem(OPACITY_KEY, String(opacity))
    } catch {
      /* private mode: not remembered */
    }
  },
  /** Every trace goes (another document was opened). */
  clear() {
    timers.forEach((t) => clearTimeout(t))
    timers.clear()
    if (store.sheets.size) emit({ sheets: new Map() })
  },
  get: (sheetId: string): SheetTrace | undefined => store.sheets.get(sheetId),
  opacity: (): number => store.opacity,
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}
const getStore = () => store

export function useTraceStore(): TraceStore {
  return useSyncExternalStore(subscribe, getStore)
}

/** The trace on one sheet, if any. Re-renders only when that sheet's trace changes. */
export function useSheetTrace(sheetId: string): SheetTrace | undefined {
  return useSyncExternalStore(subscribe, () => store.sheets.get(sheetId))
}

// The photo strokes went (undo, Remove, erased): there is nothing left on the trace, so it rolls up.
subscribeSession(() => {
  for (const [sheetId, t] of store.sheets) if (t.phase !== 'rolling' && !sheetHasPhotoInk(sheetId)) tracePaper.rollUp(sheetId)
})
