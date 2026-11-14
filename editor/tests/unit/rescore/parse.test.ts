import { describe, expect, it } from 'vitest'
import { DECISION_KINDS } from '@core/types'
import {
  RescoreParseError,
  codecFor,
  oracleProbs,
  parseHostedResponse,
  parseJevResponse,
  parseLocalResponse,
  syntheticResponse,
  ADAPTERS,
} from '@core/rescore'
import { samplePacket } from './helpers'

const sum = (p: Record<string, number>) => Object.values(p).reduce((a, b) => a + b, 0)

describe('M4-01 local adapter parsing (one token, logprobs as probabilities)', () => {
  it('reads OpenAI chat top_logprobs, sums letter variants, renormalises over A-E', () => {
    const raw = {
      choices: [
        {
          logprobs: {
            content: [
              {
                token: 'B',
                logprob: Math.log(0.6),
                top_logprobs: [
                  { token: 'B', logprob: Math.log(0.5) },
                  { token: ' B', logprob: Math.log(0.1) },
                  { token: 'A', logprob: Math.log(0.2) },
                  { token: 'Hello', logprob: Math.log(0.15) },
                  { token: 'e', logprob: Math.log(0.05) },
                ],
              },
            ],
          },
        },
      ],
    }
    const p = parseLocalResponse(raw)
    expect(sum(p)).toBeCloseTo(1, 9)
    expect(p.door).toBeGreaterThan(p.wall) // B = door (0.6) > A = wall (0.2)
    expect(p.door / p.wall).toBeCloseTo(3, 1)
    expect(p.markup).toBeGreaterThan(p.furniture) // E (0.05) > C (floor)
  })

  it('reads legacy completions and llama.cpp completion_probabilities', () => {
    const legacy = parseLocalResponse({ choices: [{ logprobs: { top_logprobs: [{ A: Math.log(0.7), C: Math.log(0.3) }] } }] })
    expect(legacy.wall).toBeGreaterThan(0.65)
    const llama = parseLocalResponse({ completion_probabilities: [{ top_logprobs: [{ token: 'D', logprob: Math.log(0.9) }] }] })
    expect(llama.delete).toBeGreaterThan(0.9)
    const llamaOld = parseLocalResponse({ completion_probabilities: [{ probs: [{ tok_str: 'E', prob: 0.8 }, { tok_str: 'A', prob: 0.2 }] }] })
    expect(llamaOld.markup).toBeGreaterThan(llamaOld.wall)
  })

  it('throws when logprobs are missing', () => {
    expect(() => parseLocalResponse({ choices: [{ message: { content: 'A' } }] })).toThrow(RescoreParseError)
    expect(() => parseLocalResponse('nope')).toThrow(RescoreParseError)
  })
})

describe('M4-01 hosted adapter parsing (decide tool with a probabilities object)', () => {
  it('reads the decide tool input and normalises (percentages too)', () => {
    const p = parseHostedResponse({
      type: 'message',
      content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'tool_use', name: 'decide', id: 't', input: { probabilities: { wall: 70, door: 20, furniture: 0, delete: 0, markup: 10 }, reason: 'x' } },
      ],
      stop_reason: 'tool_use',
    })
    expect(sum(p)).toBeCloseTo(1, 9)
    expect(p.wall).toBeCloseTo(0.7, 2)
  })

  it('rejects refusals, API errors and replies without the tool call', () => {
    expect(() => parseHostedResponse({ stop_reason: 'refusal', content: [] })).toThrow(/refused/)
    expect(() => parseHostedResponse({ type: 'error', error: { type: 'overloaded_error' } })).toThrow(/overloaded/)
    expect(() => parseHostedResponse({ content: [{ type: 'text', text: 'wall' }] })).toThrow(RescoreParseError)
  })

  it('request forces the single decide tool, no thinking, and names the latest Haiku by default', () => {
    const body = codecFor('hosted').buildRequest(samplePacket())
    expect(body.model).toBe('claude-haiku-5-5')
    expect(body.tool_choice).toEqual({ type: 'any' })
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(['decide'])
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect('temperature' in body).toBe(false)
  })
})

describe('M4-01 Jev adapter parsing (assumed typed-choices contract)', () => {
  it('reads choices[] and the probabilities-object fallback', () => {
    expect(parseJevResponse({ choices: [{ kind: 'furniture', probability: 0.8 }, { kind: 'markup', probability: 0.2 }, { kind: 'bogus', probability: 1 }] }).furniture).toBeGreaterThan(0.75)
    expect(parseJevResponse({ probabilities: { delete: 0.9, markup: 0.1 } }).delete).toBeGreaterThan(0.85)
    expect(() => parseJevResponse({ choices: [] })).toThrow(RescoreParseError)
  })
})

describe('M4-01 synthetic replies round-trip through each real parser', () => {
  it.each(ADAPTERS)('%s', (adapter) => {
    const codec = codecFor(adapter)
    const p = oracleProbs(samplePacket(), 'wall', '0123456789abcdef')
    const back = codec.parseResponse(syntheticResponse(adapter, codec.model, p))
    for (const k of DECISION_KINDS) expect(back[k]).toBeCloseTo(p[k], 2)
  })
})
