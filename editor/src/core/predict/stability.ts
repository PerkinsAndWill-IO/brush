import type { DecisionKind } from '../types'

/**
 * Engine rule 4: switch the leading kind only when a challenger leads it by
 * `margin` for `runs` runs in a row. Pure state machine.
 */
export interface StabilityState {
  leader?: DecisionKind
  challenger?: DecisionKind
  count: number
}

export const initialStability = (): StabilityState => ({ count: 0 })

export interface StabilityStep {
  state: StabilityState
  leader: DecisionKind
  /** True when the leader is also this run's top and no challenger is pending. */
  settled: boolean
  switched: boolean
}

/**
 * @param probs  confidence per kind for this run
 * @param top    this run's preferred kind (already gated by confidence/compatibility)
 * @param forced when set, the leader becomes this kind immediately (mode forcing,
 *               or the leader became incompatible with the coarse class / fell below chipLow)
 */
export function stabilityStep(
  prev: StabilityState,
  probs: Record<DecisionKind, number>,
  top: DecisionKind,
  margin: number,
  runs: number,
  forced?: DecisionKind,
): StabilityStep {
  if (forced !== undefined) {
    const switched = prev.leader !== undefined && prev.leader !== forced
    return { state: { leader: forced, count: 0 }, leader: forced, settled: forced === top, switched }
  }
  if (prev.leader === undefined) return { state: { leader: top, count: 0 }, leader: top, settled: true, switched: false }
  const L = prev.leader
  if (top === L) return { state: { leader: L, count: 0 }, leader: L, settled: true, switched: false }
  // small epsilon so a lead of exactly `margin` counts despite float rounding
  if (probs[top] - probs[L] >= margin - 1e-9) {
    const count = prev.challenger === top ? prev.count + 1 : 1
    if (count >= runs) return { state: { leader: top, count: 0 }, leader: top, settled: true, switched: true }
    return { state: { leader: L, challenger: top, count }, leader: L, settled: false, switched: false }
  }
  return { state: { leader: L, count: 0 }, leader: L, settled: false, switched: false }
}
