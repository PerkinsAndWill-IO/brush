/**
 * Erasing drawing elements: an accepted delete over items of a `.drawing` / Revit context hides that element on
 * every page (through the display filters' `erased` set). Derived from the session's accepted decisions, so undo
 * and redo bring it back and take it away again; with the Revit link on, the delete command also removes it from
 * the model. (The brush's context drops deleted items itself: withSessionElements.)
 */
import { erasedElements } from '@core/context'
import { filters } from '../drawing/filters'
import { getSession, subscribeSession } from '../session'
import { contextNow, subscribeContexts } from './contextStore'

let contextsVersion = 0
let memo: { accepted: readonly unknown[]; contexts: number; refs: ReadonlySet<string> } | null = null

/** Host element ids erased in this session (memoised on the accepted list and the built contexts). */
export function erasedNow(): ReadonlySet<string> {
  const accepted = getSession().accepted
  if (memo && memo.accepted === accepted && memo.contexts === contextsVersion) return memo.refs
  const refs = erasedElements(accepted, contextNow)
  memo = { accepted, contexts: contextsVersion, refs }
  return refs
}

let started = false
export function installErasedSync() {
  if (started) return
  started = true
  const sync = () => filters.setErased(erasedNow())
  subscribeContexts(() => {
    contextsVersion++
    sync()
  })
  subscribeSession(sync)
  sync()
}
