/**
 * View aids state (docs/tasks/V1-view-aids.md): metric grid, scale bar, label
 * size, and the measurements drawn with the Measure tool.
 *
 * Measurements are a view aid, not part of the drawing: they are not written
 * to the sidecar or the command log, and they clear when another document opens.
 * View settings persist per browser (localStorage, best effort).
 */
import { useSyncExternalStore } from 'react'
import type { Point } from '@core/types'
import { contextNow } from './brain/contextStore'
import { getSession, subscribeSession } from './session'
import { getDocState } from './store'

export interface Measurement {
  id: string
  sheetId: string
  /** Sheet points. */
  a: Point
  b: Point
}

export const LABEL_SCALES = [
  { value: 0.85, label: 'S' },
  { value: 1, label: 'M' },
  { value: 1.2, label: 'L' },
  { value: 1.45, label: 'XL' },
] as const

export interface ViewState {
  /** Metric grid on sheets whose scale is known (V1-03). */
  grid: boolean
  /** Graphic scale bar in the corner of the board (V1-01). */
  scaleBar: boolean
  /** Multiplier for on-board text: sheet names, measurement labels, chips (V1-04). */
  labelScale: number
  measurements: readonly Measurement[]
  /** Measurement being drawn (V1-02). */
  draft: Measurement | null
}

const STORAGE_KEY = 'brush.view.v1'

function loadPrefs(): Partial<ViewState> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
    if (!raw) return {}
    const p = JSON.parse(raw) as Partial<ViewState>
    const out: Partial<ViewState> = {}
    if (typeof p.grid === 'boolean') out.grid = p.grid
    if (typeof p.scaleBar === 'boolean') out.scaleBar = p.scaleBar
    if (LABEL_SCALES.some((s) => s.value === p.labelScale)) out.labelScale = p.labelScale
    return out
  } catch {
    return {}
  }
}

function savePrefs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ grid: state.grid, scaleBar: state.scaleBar, labelScale: state.labelScale }))
  } catch {
    /* storage unavailable: settings last for this page only */
  }
}

let state: ViewState = { grid: false, scaleBar: true, labelScale: 1, measurements: [], draft: null, ...loadPrefs() }
const listeners = new Set<() => void>()
function emit(next: Partial<ViewState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export const getView = (): ViewState => state
export function subscribeView(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useView = (): ViewState => useSyncExternalStore(subscribeView, getView)

let seq = 0

export const view = {
  setGrid(grid: boolean) {
    emit({ grid })
    savePrefs()
  },
  setScaleBar(scaleBar: boolean) {
    emit({ scaleBar })
    savePrefs()
  },
  setLabelScale(labelScale: number) {
    emit({ labelScale })
    savePrefs()
  },
  startMeasure(sheetId: string, a: Point) {
    emit({ draft: { id: `m${++seq}`, sheetId, a, b: a } })
  },
  moveMeasure(b: Point) {
    if (state.draft) emit({ draft: { ...state.draft, b } })
  },
  /** Keep the draft as a measurement (ignored if it has no length). */
  commitMeasure() {
    const d = state.draft
    if (!d) return
    const keep = d.a.x !== d.b.x || d.a.y !== d.b.y
    emit({ draft: null, measurements: keep ? [...state.measurements, d] : state.measurements })
  },
  cancelMeasure() {
    if (state.draft) emit({ draft: null })
  },
  removeMeasurement(id: string) {
    emit({ measurements: state.measurements.filter((m) => m.id !== id) })
  },
  removeLastMeasurement() {
    if (state.measurements.length) emit({ measurements: state.measurements.slice(0, -1) })
  },
  clearMeasurements() {
    emit({ measurements: [], draft: null })
  },
}

/** Sheet scale (100 for 1:100): from the sheet (package) or the inferred context. */
export function sheetScale(sheetId: string): number | undefined {
  return getDocState().sheets.find((s) => s.id === sheetId)?.scale ?? contextNow(sheetId)?.scale
}

// Leaving the Measure tool drops a half-drawn measurement.
subscribeSession(() => {
  if (state.draft && getSession().tool !== 'measure') view.cancelMeasure()
})
