/**
 * SYNTHETIC second-pass replies: a deterministic "oracle with noise" that KNOWS
 * THE LABEL. It exists so the cassette pipeline, parsing, fusion, timing and
 * rule 6 can be exercised end-to-end in CI before anyone records a real model.
 * Numbers produced with it prove plumbing, NOT model quality.
 */
import { DECISION_KINDS, type ContextPacket, type DecisionKind } from '../types'
import type { AdapterId } from './codecs'
import { DECIDE_TOOL } from './codecs'
import { KIND_TO_LETTER, normalizeProbs, rankKinds, type KindProbs } from './vocab'

export interface OracleOptions {
  /** Probability the simulated model puts the true label on top (default 0.75). */
  pCorrect?: number
}

/** mulberry32 seeded from a hex hash. */
export function prng(seedHex: string): () => number {
  let a = parseInt(seedHex.slice(0, 8) || '0', 16) ^ parseInt(seedHex.slice(8, 16) || '0', 16)
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

/** Simulated model probabilities for a packet whose true label is `label`. */
export function oracleProbs(packet: ContextPacket, label: DecisionKind, seedHex: string, opts: OracleOptions = {}): KindProbs {
  const rnd = prng(seedHex)
  const pCorrect = opts.pCorrect ?? 0.75
  const firstTop = [...packet.candidates].sort((a, b) => b.confidence - a.confidence)[0]?.kind
  let top: DecisionKind = label
  if (rnd() >= pCorrect) {
    // Correlated error: a wrong model usually agrees with a wrong first pass, else picks another kind.
    const others = DECISION_KINDS.filter((k) => k !== label)
    top = firstTop && firstTop !== label && rnd() < 0.6 ? firstTop : others[Math.floor(rnd() * others.length)]
  }
  const mass = 0.45 + 0.45 * rnd()
  const rest = DECISION_KINDS.filter((k) => k !== top)
  const w = rest.map(() => 0.05 + rnd())
  const ws = w.reduce((a, b) => a + b, 0)
  const p: Partial<KindProbs> = { [top]: mass }
  rest.forEach((k, i) => (p[k] = ((1 - mass) * w[i]) / ws))
  const n = normalizeProbs(p)
  for (const k of DECISION_KINDS) n[k] = r3(n[k])
  return n
}

/** Simulated latency in ms per adapter (local GPU fast, hosted slower with a tail). */
export function syntheticLatency(adapter: AdapterId, seedHex: string): number {
  const rnd = prng(seedHex.split('').reverse().join(''))
  const u = rnd()
  switch (adapter) {
    case 'local':
      return Math.round(90 + 160 * u * u)
    case 'jev':
      return Math.round(120 + 220 * u)
    case 'hosted': {
      // log-normal around 420 ms (Box-Muller), clamped
      const z = Math.sqrt(-2 * Math.log(Math.max(u, 1e-9))) * Math.cos(2 * Math.PI * rnd())
      return Math.round(Math.min(1500, Math.max(200, 420 * Math.exp(0.35 * z))))
    }
  }
}

/** The probabilities rendered in the adapter's own reply shape, so replay exercises the real parser. */
export function syntheticResponse(adapter: AdapterId, model: string, p: KindProbs): unknown {
  switch (adapter) {
    case 'local': {
      const ranked = rankKinds(p)
      const top_logprobs = ranked.map((k) => ({ token: KIND_TO_LETTER[k], logprob: r3(Math.log(p[k])) }))
      return {
        id: 'chatcmpl-synthetic',
        object: 'chat.completion',
        model,
        synthetic: true,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: KIND_TO_LETTER[ranked[0]] },
            logprobs: { content: [{ token: KIND_TO_LETTER[ranked[0]], logprob: top_logprobs[0].logprob, top_logprobs }] },
            finish_reason: 'length',
          },
        ],
      }
    }
    case 'hosted':
      return {
        id: 'msg_synthetic',
        type: 'message',
        role: 'assistant',
        model,
        synthetic: true,
        content: [
          {
            type: 'tool_use',
            id: 'toolu_synthetic',
            name: DECIDE_TOOL.name,
            input: { probabilities: Object.fromEntries(DECISION_KINDS.map((k) => [k, p[k]])), reason: 'SYNTHETIC oracle-with-noise reply' },
          },
        ],
        stop_reason: 'tool_use',
        stop_details: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    case 'jev':
      return { model, synthetic: true, choices: rankKinds(p).map((k) => ({ kind: k, probability: p[k] })) }
  }
}
