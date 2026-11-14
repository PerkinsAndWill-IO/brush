import { describe, expect, it } from 'vitest'
import { DEFAULT_RESCORE_SETTINGS, RescoreRunner, codecFor, oracleProbs, syntheticResponse, type RescoreResult, type RescoreSettings } from '@core/rescore'
import { createRescorer, hostedRescorer, jevRescorer, localRescorer } from '../../../src/app/rescore/adapters'
import { RescoreHttpError, RescoreTimeoutError, type FetchLike } from '../../../src/app/rescore/http'
import { samplePacket, sampleHypothesis } from './helpers'

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Fake fetch: answers with `reply` after `delayMs` (Infinity = never, ignoring the signal like a stuck server). */
function fakeFetch(reply: unknown, opts: { delayMs?: number; status?: number } = {}): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
    const res = { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => reply, text: async () => JSON.stringify(reply) }
    if (opts.delayMs === Infinity) return new Promise(() => {})
    return new Promise((r) => setTimeout(() => r(res), opts.delayMs ?? 0))
  }
  return { fetch, calls }
}

const S: RescoreSettings = { ...DEFAULT_RESCORE_SETTINGS, weight: 0.5, timeoutMs: 200 }
const replyFor = (adapter: 'local' | 'hosted' | 'jev') => syntheticResponse(adapter, codecFor(adapter).model, oracleProbs(samplePacket(), 'wall', 'feedfacecafebeef', { pCorrect: 1 }))

describe('M4-01 adapters over a fake fetch (no network in CI)', () => {
  it('local: POSTs one-token logprob request to the configured URL', async () => {
    const { fetch, calls } = fakeFetch(replyFor('local'))
    const out = await localRescorer({ ...S, localUrl: 'http://127.0.0.1:9999/v1/chat/completions' }, { fetch }).rescore(samplePacket(), [sampleHypothesis()])
    expect(calls[0].url).toBe('http://127.0.0.1:9999/v1/chat/completions')
    expect(calls[0].body).toMatchObject({ max_tokens: 1, logprobs: true, top_logprobs: 5, grammar: 'root ::= [A-E]' })
    expect(out[0].kind).toBe('wall')
  })

  it('hosted: Messages API URL and headers; key only when given', async () => {
    const { fetch, calls } = fakeFetch(replyFor('hosted'))
    await hostedRescorer({ ...S, hostedBaseUrl: 'https://api.anthropic.com/' }, { fetch, apiKey: 'test-key' }).rescore(samplePacket(), [sampleHypothesis()])
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0].headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' })
    const proxied = fakeFetch(replyFor('hosted'))
    await hostedRescorer({ ...S, hostedBaseUrl: 'https://proxy.example/anthropic' }, { fetch: proxied.fetch }).rescore(samplePacket(), [sampleHypothesis()])
    expect(proxied.calls[0].url).toBe('https://proxy.example/anthropic/v1/messages')
    expect(proxied.calls[0].headers['x-api-key']).toBeUndefined()
  })

  it('jev: sends the assumed typed-choices request', async () => {
    const { fetch, calls } = fakeFetch(replyFor('jev'))
    const out = await jevRescorer(S, { fetch }).rescore(samplePacket(), [sampleHypothesis()])
    expect(calls[0].body).toMatchObject({ schema: 'brush.decide/v1', choices: ['wall', 'door', 'furniture', 'delete', 'markup'] })
    expect(out[0].kind).toBe('wall')
  })

  it('times out a stuck server within timeoutMs (even if fetch ignores the signal)', async () => {
    const { fetch } = fakeFetch(replyFor('hosted'), { delayMs: Infinity })
    const t0 = performance.now()
    await expect(hostedRescorer({ ...S, timeoutMs: 40 }, { fetch }).rescore(samplePacket(), [sampleHypothesis()])).rejects.toBeInstanceOf(RescoreTimeoutError)
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('surfaces HTTP errors', async () => {
    const { fetch } = fakeFetch({ type: 'error', error: { type: 'authentication_error' } }, { status: 401 })
    await expect(hostedRescorer(S, { fetch }).rescore(samplePacket(), [sampleHypothesis()])).rejects.toBeInstanceOf(RescoreHttpError)
  })

  it('setting picks the adapter; off means no rescorer', () => {
    expect(createRescorer({ ...S, adapter: 'off' })).toBeNull()
    expect(createRescorer({ ...S, adapter: 'local' })?.name).toMatch(/^local:/)
    expect(createRescorer({ ...S, adapter: 'hosted' })?.name).toBe('hosted:claude-haiku-5-5')
    expect(createRescorer({ ...S, adapter: 'jev' })?.name).toMatch(/^jev:/)
  })
})

describe('M4-03 RescoreRunner never blocks the caller', () => {
  const req = { strokeId: 's1', run: 7, packet: samplePacket(), candidates: [sampleHypothesis()] }

  it('consider() returns synchronously; the answer arrives later through onResult with its latency', async () => {
    const { fetch } = fakeFetch(replyFor('hosted'), { delayMs: 30 })
    const results: RescoreResult[] = []
    const runner = new RescoreRunner({ rescorer: hostedRescorer(S, { fetch }), settings: { ...S, adapter: 'hosted' }, now: () => performance.now(), onResult: (r) => results.push(r) })
    expect(runner.consider(req)).toBe(true)
    expect(results).toHaveLength(0) // nothing synchronous
    expect(runner.pending).toBe(1)
    await runner.idle()
    expect(results[0]).toMatchObject({ strokeId: 's1', run: 7, status: 'ok' })
    expect(results[0].hypotheses[0].kind).toBe('wall')
    expect(runner.secondPassMs[0]).toBeGreaterThanOrEqual(25)
  })

  it('does not call the model for a confident first pass', () => {
    const runner = new RescoreRunner({ rescorer: hostedRescorer(S, fakeFetch({})), settings: { ...S, adapter: 'hosted' }, now: () => 0, onResult: () => {} })
    expect(runner.consider({ ...req, candidates: [sampleHypothesis({ confidence: 0.95, alternatives: [{ kind: 'wall', confidence: 0.05 }] })] })).toBe(false)
    expect(runner.counts.started).toBe(0)
  })

  it('times out slow answers and aborts superseded requests for the same stroke', async () => {
    const results: RescoreResult[] = []
    const slow = fakeFetch(replyFor('hosted'), { delayMs: Infinity })
    const runner = new RescoreRunner({ rescorer: hostedRescorer({ ...S, timeoutMs: 10_000 }, slow), settings: { ...S, adapter: 'hosted', timeoutMs: 30 }, now: () => performance.now(), onResult: (r) => results.push(r) })
    runner.start(req)
    runner.start({ ...req, run: 8 }) // supersedes run 7
    await runner.idle()
    expect(results.map((r) => [r.run, r.status]).sort()).toEqual([
      [7, 'aborted'],
      [8, 'timeout'],
    ])
    expect(runner.secondPassMs).toHaveLength(0)
  })
})
