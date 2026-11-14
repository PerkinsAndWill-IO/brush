import type { AcceptedDecision, Alternative, DecisionKind, Hypothesis } from '../types'
import type { AdapterId } from './codecs'

export type RescoreAdapterSetting = 'off' | AdapterId

/** Second-pass settings (kept out of the frozen BrushSettings). */
export interface RescoreSettings {
  adapter: RescoreAdapterSetting
  /** Fusion weight of the model, 0..1 (0 = first pass only). */
  weight: number
  /** Ask the model only when the first-pass top confidence is below this... */
  ambiguousBelow: number
  /** ...or the top-2 margin is below this. */
  ambiguousMargin: number
  /** Hard cap on one second-pass call; the request is aborted after it. */
  timeoutMs: number
  /** Late answers (after commit) become a suggestion chip only if their top kind reaches this. */
  suggestMin: number
  localUrl: string
  localModel: string
  /** Send a llama.cpp grammar with the local request. */
  localGrammar: boolean
  hostedModel: string
  /** Anthropic API base URL, or your proxy's (recommended for production; then no key in the client). */
  hostedBaseUrl: string
  jevUrl: string
}

export const DEFAULT_RESCORE_SETTINGS: RescoreSettings = {
  adapter: 'off',
  weight: 0.5,
  ambiguousBelow: 0.6,
  ambiguousMargin: 0.15,
  timeoutMs: 1000,
  suggestMin: 0.5,
  localUrl: 'http://127.0.0.1:8080/v1/chat/completions',
  localModel: 'local',
  localGrammar: true,
  hostedModel: 'claude-haiku-5-5',
  hostedBaseUrl: 'https://api.anthropic.com',
  jevUrl: 'http://127.0.0.1:8765/v1/decide',
}

/** Top-2 margin of a first-pass candidate list (best first). */
export function topMargin(candidates: readonly Alternative[]): number {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence)
  return (sorted[0]?.confidence ?? 0) - (sorted[1]?.confidence ?? 0)
}

/**
 * M4 policy: call the second pass only when the first pass is ambiguous —
 * top confidence below `ambiguousBelow` or top-2 margin below `ambiguousMargin`.
 * Never for an empty hypothesis or when the adapter is off.
 */
export function shouldRescore(h: Pick<Hypothesis, 'kind' | 'confidence' | 'alternatives'>, s: Pick<RescoreSettings, 'adapter' | 'ambiguousBelow' | 'ambiguousMargin'>): boolean {
  if (s.adapter === 'off') return false
  const cands: Alternative[] = [{ kind: h.kind, confidence: h.confidence }, ...h.alternatives]
  return h.confidence < s.ambiguousBelow || topMargin(cands) < s.ambiguousMargin
}

export type LateAction =
  | { action: 'apply'; hypothesis: Hypothesis }
  | { action: 'suggest'; chip: { kind: DecisionKind; confidence: number }; strokeId: string }
  | { action: 'drop'; reason: 'stale' | 'agrees' | 'weak' | 'empty' | 'other-stroke' }

/**
 * Engine rule 6 for second-pass answers. Given the rescored hypotheses for
 * (strokeId, run) and the engine's state when the answer arrives:
 *  - not committed and still on the run that was rescored -> 'apply' (replace the live hypothesis);
 *  - not committed but newer runs exist                    -> 'drop' (stale; the newer run may ask again);
 *  - committed: a different kind with confidence >= suggestMin -> 'suggest' (chip only, never re-decides);
 *               otherwise 'drop'.
 */
export function resolveAnswer(
  answer: { strokeId: string; run: number | undefined; hypotheses: readonly Hypothesis[] },
  live: { strokeId: string; run: number | undefined; committed?: Pick<AcceptedDecision, 'kind' | 'strokeId'> },
  s: Pick<RescoreSettings, 'suggestMin'>,
): LateAction {
  const top = answer.hypotheses[0]
  if (!top) return { action: 'drop', reason: 'empty' }
  const committed = live.committed && live.committed.strokeId === answer.strokeId ? live.committed : undefined
  if (committed) {
    if (top.kind === committed.kind) return { action: 'drop', reason: 'agrees' }
    if (top.confidence < s.suggestMin) return { action: 'drop', reason: 'weak' }
    return { action: 'suggest', chip: { kind: top.kind, confidence: top.confidence }, strokeId: answer.strokeId }
  }
  if (live.strokeId !== answer.strokeId) return { action: 'drop', reason: 'other-stroke' }
  if (live.run !== answer.run) return { action: 'drop', reason: 'stale' }
  return { action: 'apply', hypothesis: top }
}
