/**
 * What can be done with a photo import as a whole (P1-07, P1-08): remove all of its strokes in one step, or read
 * them as elements the way the live brush reads a stroke. Both are one undo step.
 */
import { useSyncExternalStore } from 'react'
import type { AcceptedDecision, Command, DecisionKind } from '@core/types'
import { contextFor, emptyContext } from '../brain/contextStore'
import { nextCommandId } from '../board/history'
import { getSession, session } from '../session'
import { getDocState } from '../store'
import { photoGroups } from './groups'
import { readStrokes } from './interpret'

export interface MakeElementsResult {
  /** Strokes that became elements. */
  elements: number
  /** Strokes the brush would have offered two chips for; they stay ink. */
  unsure: number
  /** Strokes read as markup; they stay ink. */
  ink: number
  byKind: Partial<Record<DecisionKind, number>>
}

interface GroupUiState {
  /** Groups being read now. */
  busy: ReadonlySet<string>
  /** The last "Make elements" result per group, for the session list. */
  results: Readonly<Record<string, MakeElementsResult>>
  /** The last failure per group. */
  errors: Readonly<Record<string, string>>
}

let ui: GroupUiState = { busy: new Set(), results: {}, errors: {} }
const listeners = new Set<() => void>()
function setUi(next: Partial<GroupUiState>) {
  ui = { ...ui, ...next }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const usePhotoGroupUi = () => useSyncExternalStore(subscribe, () => ui)

/** Strokes read between two yields to the UI. */
const CHUNK = 12

/** Command ids after the session's, one per call. */
function commandIds(commands: readonly Command[], prefix: string): () => string {
  let n = Number(/-(\d+)$/.exec(nextCommandId(commands, prefix))?.[1] ?? 1)
  return () => `${prefix}-${String(n++).padStart(4, '0')}`
}

/** Remove every stroke of a photo import (and any element made from it). One undo step. */
export function removePhotoGroup(groupId: string): number {
  const group = photoGroups(getSession().strokes, getSession().accepted).find((g) => g.id === groupId)
  if (!group) return 0
  session.removeStrokes(new Set(group.strokeIds))
  const { [groupId]: _gone, ...results } = ui.results
  setUi({ results })
  return group.strokeIds.length
}

/**
 * Read the strokes of a photo import that are not elements yet, with the brush's current settings (mode included),
 * and commit what the brush would commit on its own. One undo step.
 */
export async function makeElements(groupId: string): Promise<MakeElementsResult> {
  const doc = getDocState()
  const loadId = doc.loadId
  const start = getSession()
  const group = photoGroups(start.strokes, start.accepted).find((g) => g.id === groupId)
  if (!group) throw new Error('That photo import is no longer in the session.')
  if (ui.busy.has(groupId)) throw new Error('These strokes are being read already.')
  const { [groupId]: _old, ...errors } = ui.errors
  setUi({ busy: new Set(ui.busy).add(groupId), errors })
  try {
    const done = new Set(start.accepted.map((a) => a.strokeId))
    const ids = new Set(group.strokeIds)
    const todo = start.strokes.filter((s) => ids.has(s.id) && !done.has(s.id))
    const ctx = (await contextFor(group.sheetId)) ?? emptyContext(group.sheetId)
    const settings = { ...getSession().settings }
    const nextId = commandIds(getSession().commands, getSession().commandPrefix)
    const history: AcceptedDecision[] = getSession().accepted.slice()
    const decisions: { decision: AcceptedDecision; command: Command | null }[] = []
    const result: MakeElementsResult = { elements: 0, unsure: 0, ink: 0, byKind: {} }
    for (let i = 0; i < todo.length; i += CHUNK) {
      const part = readStrokes(todo.slice(i, i + CHUNK), ctx, settings, { palette: doc.source?.palette, history, nextCommandId: nextId, committedAt: Date.now() })
      for (const d of part.decisions) {
        decisions.push(d)
        history.push(d.decision)
      }
      for (const o of part.outcomes.values()) result[o === 'element' ? 'elements' : o]++
      for (const [k, n] of Object.entries(part.byKind)) result.byKind[k as DecisionKind] = (result.byKind[k as DecisionKind] ?? 0) + (n ?? 0)
      await new Promise((r) => setTimeout(r, 0))
      if (getDocState().loadId !== loadId) throw new Error('Another drawing was opened; nothing was changed.')
    }
    // strokes erased or undone while reading are left out
    const now = getSession()
    const present = new Set(now.strokes.map((s) => s.id))
    const taken = new Set(now.accepted.map((a) => a.strokeId))
    const keep = decisions.filter((d) => present.has(d.decision.strokeId) && !taken.has(d.decision.strokeId))
    session.commitDecisions(keep)
    if (keep.length !== decisions.length) {
      result.elements = keep.length
      result.byKind = {}
      for (const d of keep) result.byKind[d.decision.kind] = (result.byKind[d.decision.kind] ?? 0) + 1
    }
    setUi({ results: { ...ui.results, [groupId]: result } })
    return result
  } catch (e) {
    setUi({ errors: { ...ui.errors, [groupId]: (e as Error).message || String(e) } })
    throw e
  } finally {
    const busy = new Set(ui.busy)
    busy.delete(groupId)
    setUi({ busy })
  }
}
