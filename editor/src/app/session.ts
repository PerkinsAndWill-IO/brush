/**
 * Session store: strokes + undo history, active tool, brush settings, the
 * sheet being drawn on. Shared by the React tree, the board input handlers
 * and the test API. Autosaves to the sidecar through the platform adapter (M1-10).
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_BRUSH_SETTINGS, SESSION_SCHEMA_VERSION, type AcceptedDecision, type BrushSettings, type Command, type SessionFile, type Stroke } from '@core/types'
import { StrokeHistory, type Removed } from './board/history'
import { getPlatform, type SidecarKey } from './platform'

export type Tool = 'select' | 'brush' | 'eraser' | 'pan' | 'measure'

export interface SessionState {
  strokes: readonly Stroke[]
  /** Accepted predictions (M3), one per committed stroke; markup is never stored. */
  accepted: readonly AcceptedDecision[]
  /** The command log (M3/M5). */
  commands: readonly Command[]
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
  /** Dev/debug: draw the detected context on every sheet (M2). */
  contextOverlay: boolean
  /**
   * Strokes not drawn and not erasable (M6-04): their commands landed in the linked model, whose sheet now draws
   * the real elements. They stay in the history, so undo still reaches them.
   */
  hidden: ReadonlySet<string>
  /** Prefix of new command ids. A linked session gets its own, so its ids never collide with an earlier session's. */
  commandPrefix: string
}

const NO_HIDDEN: ReadonlySet<string> = new Set()

const history = new StrokeHistory()
let state: SessionState = {
  strokes: [],
  accepted: [],
  commands: [],
  canUndo: false,
  canRedo: false,
  tool: 'brush',
  settings: { ...DEFAULT_BRUSH_SETTINGS },
  eraserSize: 12,
  activeSheetId: null,
  saved: 'idle',
  contextOverlay: false,
  hidden: NO_HIDDEN,
  commandPrefix: 'cmd',
}
const listeners = new Set<() => void>()

function emit(next: Partial<SessionState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

function syncStrokes(dirty = true) {
  emit({ strokes: history.strokes(), accepted: history.accepted(), commands: history.commands(), canUndo: history.canUndo(), canRedo: history.canRedo() })
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
    if (key === 'contextOverlay') return emit({ contextOverlay: !!value })
    emit({ settings: { ...state.settings, [key]: value } as BrushSettings })
  },
  setActiveSheet(id: string | null) {
    if (state.activeSheetId !== id) emit({ activeSheetId: id })
  },
  addStroke(stroke: Stroke) {
    history.add(stroke)
    syncStrokes()
  },
  /** Add several strokes as one undo step (photo import). */
  addStrokes(strokes: readonly Stroke[]) {
    if (!strokes.length) return
    history.addMany(strokes)
    syncStrokes()
  },
  /** Live erasing during a gesture; call commitErase at pen-up. */
  /** Accept a prediction for a committed stroke (M3). Undoable; the stroke's ink stays. */
  commitDecision(decision: AcceptedDecision, command: Command | null) {
    history.commit(decision, command)
    syncStrokes()
  },
  eraseLive(ids: ReadonlySet<string>): Removed[] {
    const removed = history.removeLive(ids)
    if (removed.length) syncStrokes(false)
    return removed
  },
  commitErase(removed: Removed[]) {
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
  /** M6-04: strokes to leave out of the board (their elements are on the linked sheet now). */
  setHidden(ids: ReadonlySet<string>) {
    const cur = state.hidden
    if (cur.size === ids.size && [...ids].every((id) => cur.has(id))) return
    emit({ hidden: ids.size ? new Set(ids) : NO_HIDDEN })
  },
  /** New document: replace strokes, clear history, no save. */
  reset(strokes: readonly Stroke[] = [], accepted: readonly AcceptedDecision[] = [], commands: readonly Command[] = [], commandPrefix = 'cmd') {
    history.reset(strokes, accepted, commands)
    emit({ activeSheetId: null, saved: 'idle', hidden: NO_HIDDEN, commandPrefix })
    syncStrokes(false)
  },
  /**
   * "Clear session": drop every stroke, reading and command for the open drawing and start over. Not undoable
   * (the history goes too); the empty session is autosaved, so a reload stays clear.
   */
  clear() {
    history.reset([], [], [])
    emit({ activeSheetId: null, hidden: NO_HIDDEN })
    syncStrokes()
  },
  /** Dev/test: bulk insert without history (perf fixtures). */
  bulkLoad(strokes: readonly Stroke[]) {
    history.reset([...history.strokes(), ...strokes], history.accepted(), history.commands())
    syncStrokes()
  },
}

// ───────────── autosave (M1-10) ─────────────

let sidecarKey: SidecarKey | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()
const SAVE_DEBOUNCE_MS = 300

export function sessionFileFor(
  key: SidecarKey,
  strokes: readonly Stroke[],
  accepted: readonly AcceptedDecision[] = [],
  commands: readonly Command[] = [],
): SessionFile {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    pdf: { name: key.name, size: key.size },
    strokes: strokes.slice(),
    accepted: accepted.slice(),
    commands: commands.slice(),
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
  const file = sessionFileFor(key, history.strokes(), history.accepted(), history.commands())
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
  let accepted: AcceptedDecision[] = []
  let commands: Command[] = []
  try {
    const file = await (await getPlatform()).readSidecar(key)
    if (file && file.schemaVersion === SESSION_SCHEMA_VERSION && Array.isArray(file.strokes)) {
      const ids = new Set(sheetIds)
      restored = file.strokes.filter((s) => ids.has(s.sheetId) && Array.isArray(s.points))
      const strokeIds = new Set(restored.map((s) => s.id))
      accepted = (file.accepted ?? []).filter((d) => strokeIds.has(d.strokeId))
      commands = (file.commands ?? []).filter((c) => strokeIds.has(c.strokeId))
    }
  } catch (e) {
    console.warn('could not read sidecar', e)
  }
  session.reset(restored, accepted, commands)
  sidecarKey = key
}

/**
 * A session with no sidecar (M6: a linked Revit sheet; the model is the record). Command ids get a prefix unique to
 * this session, because the plugin remembers the ids it applied for as long as Revit runs.
 */
export async function openEphemeralSession(): Promise<void> {
  if (saveTimer) await flushSave()
  sidecarKey = null
  const tag = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  session.reset([], [], [], `cmd-${tag}`)
}

export function closeSession() {
  sidecarKey = null
  session.reset()
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushSave())
}
