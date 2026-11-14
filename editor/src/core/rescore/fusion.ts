import { DECISION_KINDS, type Alternative, type DecisionKind, type Hypothesis } from '../types'
import { PROB_FLOOR, normalizeProbs, rankKinds, type KindProbs } from './vocab'

/**
 * First-pass probabilities from the packet's candidate list (best + alternatives).
 * Kinds missing from the list get the floor.
 */
export function firstPassProbs(candidates: readonly Alternative[]): KindProbs {
  const p: Partial<Record<DecisionKind, number>> = {}
  for (const c of candidates) p[c.kind] = Math.max(p[c.kind] ?? 0, c.confidence)
  return normalizeProbs(p)
}

/**
 * Weighted log-linear fusion: log q(k) = (1 - w) log p_first(k) + w log p_model(k), renormalised.
 *  - w = 0 returns the first pass unchanged (the model can be removed without changing the flow).
 *  - w = 0.5 is the normalised geometric mean (default).
 *  - w = 1 is the model alone.
 */
export function fuse(first: KindProbs, model: KindProbs, weight: number): KindProbs {
  const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0))
  // Inputs are already floored by normalizeProbs; the tiny clamp only guards hand-made inputs against log(0).
  const lg = (x: number) => Math.log(Math.max(x, PROB_FLOOR * 1e-3))
  const logs = DECISION_KINDS.map((k) => (1 - w) * lg(first[k]) + w * lg(model[k]))
  const m = Math.max(...logs)
  const out = {} as KindProbs
  let sum = 0
  DECISION_KINDS.forEach((k, i) => {
    out[k] = Math.exp(logs[i] - m)
    sum += out[k]
  })
  for (const k of DECISION_KINDS) out[k] /= sum
  return out
}

/** Evidence line the Reading panel shows for a rescored hypothesis (M4-06). */
export function rescoreEvidence(adapter: string, model: KindProbs, weight: number): string {
  const top = rankKinds(model).slice(0, 2)
  return `second pass (${adapter}, w=${weight}): ${top.map((k) => `${k} ${model[k].toFixed(2)}`).join(', ')}`
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * Fused probabilities back to Hypothesis[]: one hypothesis per kind, best first,
 * each with the other kinds as ranked alternatives. Geometry/type/targets come from
 * the first-pass candidate of the same kind when there is one, else from the
 * first-pass leader (the engine re-fits on apply if it needs to).
 */
export function toHypotheses(fused: KindProbs, candidates: readonly Hypothesis[], extraEvidence?: string): Hypothesis[] {
  const leader = candidates[0]
  if (!leader) return []
  const ranked = rankKinds(fused)
  return ranked.map((kind) => {
    const src = candidates.find((c) => c.kind === kind) ?? leader
    const h: Hypothesis = {
      ...src,
      kind,
      confidence: r3(fused[kind]),
      alternatives: ranked.filter((k) => k !== kind).map((k) => ({ kind: k, confidence: r3(fused[k]) })),
    }
    if (extraEvidence) h.evidence = [...(src.evidence ?? []), extraEvidence]
    return h
  })
}
