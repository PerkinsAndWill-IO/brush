import { DECISION_KINDS, type DecisionKind } from '../types'

/** Per-kind probabilities, always over all five DECISION_KINDS, summing to 1. */
export type KindProbs = Record<DecisionKind, number>

/** Options are labelled A–E in DECISION_KINDS order. Fixed, so a one-token answer maps back without the prompt. */
export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const
export type OptionLetter = (typeof OPTION_LETTERS)[number]

export const LETTER_TO_KIND: Record<OptionLetter, DecisionKind> = {
  A: DECISION_KINDS[0],
  B: DECISION_KINDS[1],
  C: DECISION_KINDS[2],
  D: DECISION_KINDS[3],
  E: DECISION_KINDS[4],
}
export const KIND_TO_LETTER = Object.fromEntries(OPTION_LETTERS.map((l) => [LETTER_TO_KIND[l], l])) as Record<DecisionKind, OptionLetter>

/** What each kind means, shared by every prompt so adapters see the same vocabulary. */
export const KIND_MEANING: Record<DecisionKind, string> = {
  wall: 'create a wall along the stroke',
  door: 'place a door in a wall the stroke crosses',
  furniture: 'place a furniture/fixture instance in the outlined area',
  delete: 'delete the element(s) the stroke scribbles over',
  markup: 'keep as plain ink (annotation, no model change)',
}

/** Smallest probability any kind gets before logs are taken (keeps fusion finite). */
export const PROB_FLOOR = 1e-3

/** Floor, then renormalise; unknown / non-finite / negative entries count as 0. */
export function normalizeProbs(p: Partial<Record<DecisionKind, number>>, floor = PROB_FLOOR): KindProbs {
  const out = {} as KindProbs
  let sum = 0
  for (const k of DECISION_KINDS) {
    const v = p[k]
    const x = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
    out[k] = Math.max(x, floor)
    sum += out[k]
  }
  for (const k of DECISION_KINDS) out[k] /= sum
  return out
}

export function argmaxKind(p: KindProbs): DecisionKind {
  let best: DecisionKind = DECISION_KINDS[0]
  for (const k of DECISION_KINDS) if (p[k] > p[best]) best = k
  return best
}

/** Kinds sorted by probability, descending; ties keep DECISION_KINDS order (deterministic). */
export function rankKinds(p: KindProbs): DecisionKind[] {
  return [...DECISION_KINDS].sort((a, b) => p[b] - p[a] || DECISION_KINDS.indexOf(a) - DECISION_KINDS.indexOf(b))
}
