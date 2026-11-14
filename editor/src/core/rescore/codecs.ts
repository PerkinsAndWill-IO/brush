/**
 * Request builders and response parsers for the three second-pass adapters
 * (docs/spec.md "Second pass (M4)"). Pure: no network. The app adapters in
 * src/app/rescore send `buildRequest(packet)` as the JSON body and hand the
 * JSON reply to `parseResponse`; the CassetteRescorer hashes the same body to
 * find a recorded reply. See docs/decisions/0004-second-pass-adapters.md.
 */
import { DECISION_KINDS, type ContextPacket, type DecisionKind } from '../types'
import { packetText, packetView } from './packet-view'
import { KIND_MEANING, KIND_TO_LETTER, LETTER_TO_KIND, OPTION_LETTERS, normalizeProbs, type KindProbs, type OptionLetter } from './vocab'

export type AdapterId = 'local' | 'hosted' | 'jev'
export const ADAPTERS: readonly AdapterId[] = ['local', 'hosted', 'jev'] as const

export class RescoreParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RescoreParseError'
  }
}

export interface RescoreCodec {
  readonly adapter: AdapterId
  readonly model: string
  /** JSON request body. Deterministic for a given packet (the cassette key is its hash). */
  buildRequest(packet: ContextPacket): Record<string, unknown>
  /** Per-kind probabilities from the adapter's JSON reply; throws RescoreParseError. */
  parseResponse(raw: unknown): KindProbs
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

const TASK =
  'You read a pen stroke drawn on an architectural floor plan PDF and decide what the user meant. ' +
  'Use the stroke shape, its size in metres, nearby drawing elements, the room and recent decisions. ' +
  'The first-pass guess comes from fast rules and is often right; disagree only with a reason.'

const optionLines = (): string => DECISION_KINDS.map((k) => `${KIND_TO_LETTER[k]}) ${k}: ${KIND_MEANING[k]}`).join('\n')

// ───────────────────────────── local (OpenAI-compatible / llama.cpp server) ─────────────────────────────

export interface LocalCodecOptions {
  model?: string
  /** Send a llama.cpp GBNF grammar restricting the answer to one of A–E (llama.cpp server only). Default true. */
  grammar?: boolean
}

/** One output token, options labelled A–E, option probabilities read from top_logprobs. */
export function localCodec(opts: LocalCodecOptions = {}): RescoreCodec {
  const model = opts.model ?? 'local'
  const grammar = opts.grammar ?? true
  return {
    adapter: 'local',
    model,
    buildRequest(packet) {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: `${TASK}\nAnswer with exactly one capital letter.` },
          { role: 'user', content: `${packetText(packetView(packet))}\n\nOptions:\n${optionLines()}\n\nAnswer (one letter A-E):` },
        ],
        max_tokens: 1,
        temperature: 0,
        logprobs: true,
        top_logprobs: OPTION_LETTERS.length,
      }
      if (grammar) body.grammar = 'root ::= [A-E]'
      return body
    },
    parseResponse: parseLocalResponse,
  }
}

function letterOf(token: unknown): OptionLetter | undefined {
  if (typeof token !== 'string') return undefined
  const t = token.trim().toUpperCase()
  return (OPTION_LETTERS as readonly string[]).includes(t) ? (t as OptionLetter) : undefined
}

/**
 * Reads option probabilities from one-token logprobs. Accepts:
 *  - OpenAI chat completions:   choices[0].logprobs.content[0].top_logprobs = [{ token, logprob }]
 *  - OpenAI legacy completions: choices[0].logprobs.top_logprobs[0] = { token: logprob }
 *  - llama.cpp /completion:     completion_probabilities[0].top_logprobs = [{ token, logprob }]
 *                               or (older) completion_probabilities[0].probs = [{ tok_str, prob }]
 * Variants of a letter (" A", "a") are summed; mass on non-option tokens is dropped (renormalised over A–E).
 */
export function parseLocalResponse(raw: unknown): KindProbs {
  if (!isObj(raw)) throw new RescoreParseError('local: reply is not an object')
  const acc: Partial<Record<DecisionKind, number>> = {}
  let found = 0
  const add = (token: unknown, p: number) => {
    const l = letterOf(token)
    if (!l || !Number.isFinite(p)) return
    const k = LETTER_TO_KIND[l]
    acc[k] = (acc[k] ?? 0) + p
    found++
  }
  const choice = Array.isArray(raw.choices) && isObj(raw.choices[0]) ? raw.choices[0] : undefined
  const lp = choice && isObj(choice.logprobs) ? choice.logprobs : undefined
  if (lp && Array.isArray(lp.content) && isObj(lp.content[0]) && Array.isArray(lp.content[0].top_logprobs)) {
    for (const e of lp.content[0].top_logprobs) if (isObj(e) && typeof e.logprob === 'number') add(e.token, Math.exp(e.logprob))
  } else if (lp && Array.isArray(lp.top_logprobs) && isObj(lp.top_logprobs[0])) {
    for (const [tok, v] of Object.entries(lp.top_logprobs[0])) if (typeof v === 'number') add(tok, Math.exp(v))
  } else if (Array.isArray(raw.completion_probabilities) && isObj(raw.completion_probabilities[0])) {
    const cp = raw.completion_probabilities[0]
    if (Array.isArray(cp.top_logprobs)) for (const e of cp.top_logprobs) isObj(e) && typeof e.logprob === 'number' && add(e.token, Math.exp(e.logprob))
    else if (Array.isArray(cp.probs)) for (const e of cp.probs) isObj(e) && typeof e.prob === 'number' && add(e.tok_str, e.prob)
  }
  if (!found) throw new RescoreParseError('local: no A-E option tokens in the logprobs (is logprobs/top_logprobs enabled?)')
  return normalizeProbs(acc)
}

// ───────────────────────────── hosted (Anthropic Messages API) ─────────────────────────────

/** Latest Claude Haiku (claude-api skill, cached 2026-11-03). */
export const DEFAULT_HOSTED_MODEL = 'claude-haiku-5-5'

export interface HostedCodecOptions {
  model?: string
  maxTokens?: number
  /** Default { type: 'any' } (only one tool, so this forces `decide`). Use 'auto' for models that reject forced tool use. */
  toolChoice?: 'any' | 'auto'
}

/** The single tool the hosted model must call: the vocabulary as an object of probabilities. */
export const DECIDE_TOOL = {
  name: 'decide',
  description:
    'Report what the stroke most likely means as a probability for EACH option (0..1, summing to 1). ' +
    DECISION_KINDS.map((k) => `${k}: ${KIND_MEANING[k]}.`).join(' '),
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      probabilities: {
        type: 'object',
        properties: Object.fromEntries(DECISION_KINDS.map((k) => [k, { type: 'number', description: `P(${k})` }])),
        required: [...DECISION_KINDS],
        additionalProperties: false,
      },
      reason: { type: 'string', description: 'One short sentence: the deciding evidence.' },
    },
    required: ['probabilities', 'reason'],
    additionalProperties: false,
  },
} as const

export function hostedCodec(opts: HostedCodecOptions = {}): RescoreCodec {
  const model = opts.model ?? DEFAULT_HOSTED_MODEL
  const maxTokens = opts.maxTokens ?? 256
  const toolChoice = opts.toolChoice ?? 'any'
  return {
    adapter: 'hosted',
    model,
    buildRequest(packet) {
      return {
        model,
        max_tokens: maxTokens,
        // Latency first: no thinking, low effort. One forced tool call is the whole answer.
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
        system: `${TASK}\nAlways answer by calling the decide tool once, with calibrated probabilities for all five options.`,
        tools: [DECIDE_TOOL],
        tool_choice: { type: toolChoice },
        messages: [{ role: 'user', content: `${packetText(packetView(packet))}\n\nOptions:\n${optionLines()}` }],
      }
    },
    parseResponse: parseHostedResponse,
  }
}

/** Reads `decide` tool input probabilities from a Messages API reply. */
export function parseHostedResponse(raw: unknown): KindProbs {
  if (!isObj(raw)) throw new RescoreParseError('hosted: reply is not an object')
  if (raw.type === 'error') throw new RescoreParseError(`hosted: API error ${isObj(raw.error) ? String(raw.error.type) : ''}`.trim())
  if (raw.stop_reason === 'refusal') throw new RescoreParseError('hosted: model refused')
  const content = Array.isArray(raw.content) ? raw.content : []
  const block = content.find((b) => isObj(b) && b.type === 'tool_use' && b.name === DECIDE_TOOL.name)
  if (!isObj(block) || !isObj(block.input) || !isObj(block.input.probabilities))
    throw new RescoreParseError('hosted: no decide tool call with a probabilities object')
  const probs = block.input.probabilities
  const p: Partial<Record<DecisionKind, number>> = {}
  for (const k of DECISION_KINDS) if (typeof probs[k] === 'number') p[k] = probs[k] as number
  if (!Object.keys(p).length) throw new RescoreParseError('hosted: probabilities object has no known kinds')
  return normalizeProbs(p)
}

// ───────────────────────────── Jev (ASSUMED contract) ─────────────────────────────

/**
 * ASSUMED CONTRACT — placeholder until the Jev team publishes theirs.
 * Request:  POST <jevUrl>  { schema: 'brush.decide/v1', model, choices: DecisionKind[], context: PacketView,
 *                            prior: { [kind]: number } }
 * Response: { choices: [{ kind: DecisionKind, probability: number }], model?: string }
 *           (also accepted: { probabilities: { [kind]: number } })
 */
export const JEV_SCHEMA = 'brush.decide/v1'

export function jevCodec(opts: { model?: string } = {}): RescoreCodec {
  const model = opts.model ?? 'jev'
  return {
    adapter: 'jev',
    model,
    buildRequest(packet) {
      const view = packetView(packet)
      return {
        schema: JEV_SCHEMA,
        model,
        choices: [...DECISION_KINDS],
        context: view,
        prior: Object.fromEntries(view.cand),
      }
    },
    parseResponse: parseJevResponse,
  }
}

export function parseJevResponse(raw: unknown): KindProbs {
  if (!isObj(raw)) throw new RescoreParseError('jev: reply is not an object')
  const p: Partial<Record<DecisionKind, number>> = {}
  if (Array.isArray(raw.choices)) {
    for (const c of raw.choices)
      if (isObj(c) && typeof c.kind === 'string' && (DECISION_KINDS as readonly string[]).includes(c.kind) && typeof c.probability === 'number')
        p[c.kind as DecisionKind] = (p[c.kind as DecisionKind] ?? 0) + c.probability
  } else if (isObj(raw.probabilities)) {
    for (const k of DECISION_KINDS) if (typeof raw.probabilities[k] === 'number') p[k] = raw.probabilities[k] as number
  }
  if (!Object.keys(p).length) throw new RescoreParseError('jev: no typed choices with probabilities')
  return normalizeProbs(p)
}

export function codecFor(adapter: AdapterId, opts: { model?: string; grammar?: boolean; toolChoice?: 'any' | 'auto' } = {}): RescoreCodec {
  switch (adapter) {
    case 'local':
      return localCodec(opts)
    case 'hosted':
      return hostedCodec(opts)
    case 'jev':
      return jevCodec(opts)
  }
}
