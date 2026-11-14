/**
 * Live reading of the stroke in progress (M2 snap markers, M3 ghost, chips,
 * Reading panel). Written by the predict engine, read by the overlays and the
 * right sidebar. Kept outside React; components subscribe.
 */
import { useSyncExternalStore } from 'react'
import type { AcceptedDecision, DecisionKind, Hypothesis, Point } from '@core/types'
import type { SnapResult } from '@core/geometry'

export type LivePhase =
  /** nothing read yet / Live off */
  | 'idle'
  /** pen down, hypotheses streaming */
  | 'drawing'
  /** pen up, waiting for the commit pause */
  | 'pending'
  /** pen up, low confidence: two chips offered, waiting for a tap (state 6) */
  | 'offer'
  /** element committed */
  | 'committed'
  /** read as markup (or dismissed): the ink stays ink */
  | 'markup'

export interface LiveState {
  phase: LivePhase
  strokeId?: string
  sheetId?: string
  hypothesis?: Hypothesis
  /** Every hypothesis of the current/last stroke, in order (window.__brush.hypotheses()). */
  history: readonly Hypothesis[]
  chips: readonly DecisionKind[]
  /** Last pen position, sheet pts (chip anchor). */
  pen?: Point
  snapStart?: SnapResult
  snapEnd?: SnapResult
  decision?: AcceptedDecision
  /** The sheet had no usable context: shape-only reading. */
  shapeOnly: boolean
  /** Pointer-down event time (performance.now clock), for the first-hypothesis mark. */
  downTs?: number
  /** Where the live hypothesis came from: the rules, or a second-pass answer applied before commit (M4). */
  origin?: 'rules' | 'model'
  /** M4 rule 6: a late second-pass answer after commit is only a suggestion chip. */
  suggestion?: { strokeId: string; kind: DecisionKind; confidence: number }
  /** True while a second-pass call for this stroke is in flight. */
  asking?: boolean
  /** Last first-hypothesis latency, ms (top bar readout). */
  lastFirstMs?: number
  /** M3-11: ids of the strokes read together as the current gesture, oldest first (the last one is `strokeId`). */
  gesture?: readonly string[]
  /** M3-11: every multi-stroke gesture this session, keyed by its last stroke id (the decision's strokeId). */
  gestures: Readonly<Record<string, readonly string[]>>
}

/**
 * M3-11 gesture grouping in the live brush. A new stroke joins the previous
 * one's reading when the previous one has not become an element yet (still
 * pending, offered as chips, or kept as ink), is on the same sheet, ended at
 * most `gapMs` ago, and the new stroke starts within `distPt` of it.
 */
export const GESTURE = {
  /** Max time from the previous pen-up to the next pen-down. */
  gapMs: 1000,
  /** Max distance from the new stroke's first point to the gesture's ink, sheet pts. */
  distPt: 40,
  /** Commit pause once a gesture has more than one stroke: room to add the next one. */
  pauseMs: 900,
}

/** The commit pause for a reading made of `strokes` strokes. */
export const commitPauseFor = (settings: { commitPauseMs: number }, strokes = 1) =>
  strokes > 1 ? Math.max(settings.commitPauseMs, GESTURE.pauseMs) : settings.commitPauseMs

const initial: LiveState = { phase: 'idle', history: [], chips: [], shapeOnly: false, gestures: {} }
let state: LiveState = initial
const listeners = new Set<() => void>()

export const getLive = () => state
export function setLive(next: Partial<LiveState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
export function resetLive() {
  setLive({ ...initial, lastFirstMs: state.lastFirstMs })
}
export const subscribeLive = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useLive = () => useSyncExternalStore(subscribeLive, getLive)
