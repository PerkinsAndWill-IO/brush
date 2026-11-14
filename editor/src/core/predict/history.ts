import type { AcceptedDecision, DecisionKind } from '../types'

/**
 * Session-history hook (spec "What counts as context": sequences — a door often
 * follows a wall, desks repeat). Returns multipliers on raw rule scores.
 * Deliberately mild: history may break ties, never override shape + context.
 */
export type SequencePrior = (history: readonly AcceptedDecision[]) => Partial<Record<DecisionKind, number>>

export const defaultSequencePrior: SequencePrior = (history) => {
  const last = history[history.length - 1]
  if (!last) return {}
  switch (last.kind) {
    case 'wall':
      return { wall: 1.05, door: 1.05 }
    case 'door':
      return { door: 1.03, wall: 1.03 }
    case 'furniture':
      return { furniture: 1.08 }
    case 'delete':
      return { delete: 1.05 }
    default:
      return {}
  }
}

export const noSequencePrior: SequencePrior = () => ({})
