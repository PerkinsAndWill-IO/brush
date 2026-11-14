/**
 * Session store: strokes + undo history, active tool, brush settings, the
 * sheet being drawn on. Shared by the React tree, the board input handlers
 * and the test API. Autosaves to the sidecar through the platform adapter (M1-10).
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_BRUSH_SETTINGS, SESSION_SCHEMA_VERSION, type BrushSettings, type SessionFile, type Stroke } from '@core/types'
import { StrokeHistory } from './board/history'
import { getPlatform, type SidecarKey } from './platform'

export type Tool = 'select' | 'brush' | 'eraser' | 'pan'

export interface SessionState {
  strokes: readonly Stroke[]
  canUndo: boolean
  canRedo: boolean
  tool: Tool
  settings: BrushSettings
  /** Eraser radius in screen px. */
  eraserSize: number
  /** Sheet that was drawn on last (accent outline). */
  activeSheetId: string | null
  /** Last autosave result, for the UI. */
  saved: 'idle' | 'pending' | 'saved' | 'error'
}

const history = new StrokeHistory()
let state: SessionState = {
  strokes: [],
  canUndo: false,
  canRedo: false,
  tool: 'brush',
  settings: { ...DEFAULT_BRUSH_SETTINGS },
  eraserSize: 12,
  activeSheetId: null,
  saved: 'idle',
}
const listeners = new Set<() => void>()

function emit(next: Partial<SessionState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

function syncStrokes(dirty = true) {
  emit({ strokes: history.strokes(), canUndo: history.canUndo(), canRedo: history.canRedo() })
  if (dirty) scheduleSave()
}

export const getSession = (): SessionState => state
export function subscribeSession(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSession)
}

export const session = {
  setTool(tool: Tool) {
    if (state.tool !== tool) emit({ tool })
  },
  setSetting(key: string, value: unknown) {
    if (key === 'tool') return session.setTool(value as Tool)
    if (key === 'eraserSize') return emit({ eraserSize: Number(value) })
    emit({ settings: { ...state.settings, [key]: value } as BrushSettings })
  },
  setActiveSheet(id: string | null) {
    if (state.activeSheetId !== id) emit({ activeSheetId: id })
  },
  addStroke(stroke: Stroke) {
    history.add(stroke)
    syncStrokes()
  },
  /** Live erasing during a gesture; call commitErase at pen-up. */
  eraseLive(ids: ReadonlySet<string>): { stroke: Stroke; index: number }[] {
    const removed = history.removeLive(ids)
    if (removed.length) syncStrokes(false)
    return removed
  },
  commitErase(removed: { stroke: Stroke; index: number }[]) {
    if (!removed.length) return
    history.commitErase(removed)
    syncStrokes()
  },
  undo() {
    if (history.undo()) syncStrokes()
  },
  redo() {
    if (history.redo()) syncStrokes()
  },
  /** New document: replace strokes, clear history, no save. */
  reset(strokes: readonly Stroke[] = []) {
    history.reset(strokes)
    emit({ activeSheetId: null, saved: 'idle' })
    syncStrokes(false)
  },
  /** Dev/test: bulk insert without history (perf fixtures). */
  bulkLoad(strokes: readonly Stroke[]) {
    history.reset([...history.strokes(), ...strokes])
    syncStrokes()
  },
}

// ───────────── autosave (M1-10) ─────────────

let sidecarKey: SidecarKey | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
const SAVE_DEBOUNCE_MS = 300

export function sessionFileFor(key: SidecarKey, strokes: readonly Stroke[]): SessionFile {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    pdf: { name: key.name, size: key.size },
    strokes: strokes.slice(),
    accepted: [],
    commands: [],
    savedAt: Date.now(),
  }
}

function scheduleSave() {
  if (!sidecarKey) return
  if (saveTimer) clearTimeout(saveTimer)
  emit({ saved: 'pending' })
  saveTimer = setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS)
}

/** Write the sidecar now (also used by tests before a reload). */
export function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  } else if (state.saved !== 'pending') return saving
  const key = sidecarKey
  if (!key) return saving
  const file = sessionFileFor(key, history.strokes())
  saving = saving
    .then(() => getPlatform())
    .then((p) => p.writeSidecar(key, file))
    .then(
      () => emit({ saved: 'saved' }),
      (e) => {
        console.error('autosave failed', e)
        emit({ saved: 'error' })
      },
    )
  return saving
}

/** Bind the session to a PDF: restore its sidecar if one exists (sheet ids must still exist). */
export async function openSession(key: SidecarKey, sheetIds: readonly string[]): Promise<void> {
  if (saveTimer) await flushSave()
  sidecarKey = null
  session.reset()
  let restored: Stroke[] = []
  try {
    const file = await (await getPlatform()).readSidecar(key)
    if (file && file.schemaVersion === SESSION_SCHEMA_VERSION && Array.isArray(file.strokes)) {
      const ids = new Set(sheetIds)
      restored = file.strokes.filter((s) => ids.has(s.sheetId) && Array.isArray(s.points))
    }
  } catch (e) {
    console.warn('could not read sidecar', e)
  }
  session.reset(restored)
  sidecarKey = key
}

export function closeSession() {
  sidecarKey = null
  session.reset()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushSave())
}
