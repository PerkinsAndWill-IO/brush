/**
 * Dev-only stroke recorder (M1-12). While on, every finished stroke (brush or
 * eraser) becomes a StrokeRecording with the chosen label, kept in memory and
 * saved as `<kind>-<n>.json` through the platform adapter. Feeds
 * fixtures/strokes/** for M3.
 */
import { useSyncExternalStore } from 'react'
import type { DecisionKind, Stroke, StrokeRecording } from '@core/types'
import { getPlatform } from './platform'

export interface SavedRecording {
  fileName: string
  recording: StrokeRecording
  saved: boolean
}

export interface RecorderState {
  enabled: boolean
  kind: DecisionKind
  note: string
  author: string
  items: readonly SavedRecording[]
}

let state: RecorderState = { enabled: false, kind: 'wall', note: '', author: '', items: [] }
const listeners = new Set<() => void>()
const emit = (next: Partial<RecorderState>) => {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const getRecorder = () => state
export const useRecorder = () => useSyncExternalStore(subscribe, getRecorder)

/** Shown only in dev/test builds. */
export const recorderAvailable = (): boolean => import.meta.env.DEV || import.meta.env.VITE_TEST === '1'

export const recorder = {
  setEnabled: (enabled: boolean) => emit({ enabled }),
  setKind: (kind: DecisionKind) => emit({ kind }),
  setNote: (note: string) => emit({ note }),
  setAuthor: (author: string) => emit({ author }),
  clear: () => emit({ items: [] }),

  /** Called by the board when a stroke ends. No-op unless recording is on. */
  capture(stroke: Stroke, pdf: string, pageIndex: number): SavedRecording | null {
    if (!state.enabled || stroke.points.length === 0) return null
    const recording: StrokeRecording = {
      pdf,
      sheet: pageIndex,
      label: state.note ? { kind: state.kind, note: state.note } : { kind: state.kind },
      points: stroke.points.map((p) => ({ ...p })),
      tool: stroke.tool,
    }
    if (state.author) recording.author = state.author
    const n = state.items.filter((r) => r.recording.label.kind === state.kind).length
    const item: SavedRecording = { fileName: `${state.kind}-${Date.now().toString(36)}-${n}.json`, recording, saved: false }
    emit({ items: [...state.items, item] })
    return item
  },

  async save(fileName: string): Promise<string> {
    const item = state.items.find((r) => r.fileName === fileName)
    if (!item) throw new Error(`no recording ${fileName}`)
    const json = JSON.stringify(item.recording)
    await (await getPlatform()).saveTextFile(item.fileName, json)
    emit({ items: state.items.map((r) => (r.fileName === fileName ? { ...r, saved: true } : r)) })
    return json
  },
}

/** Runtime check that a parsed JSON value is a StrokeRecording (used when re-reading). */
export function isStrokeRecording(v: unknown): v is StrokeRecording {
  const r = v as StrokeRecording
  return (
    !!r &&
    typeof r.pdf === 'string' &&
    Number.isInteger(r.sheet) &&
    typeof r.label?.kind === 'string' &&
    Array.isArray(r.points) &&
    r.points.every((p) => typeof p.x === 'number' && typeof p.y === 'number' && typeof p.t === 'number')
  )
}
