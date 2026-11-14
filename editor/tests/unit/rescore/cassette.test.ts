import { describe, expect, it } from 'vitest'
import {
  CASSETTE_SCHEMA,
  CassetteMissError,
  CassetteRescorer,
  canonicalJson,
  codecFor,
  hash64,
  oracleProbs,
  requestHash,
  syntheticResponse,
  type Cassette,
  type Sleep,
} from '@core/rescore'
import { samplePacket, sampleHypothesis } from './helpers'

describe('M4-01 cassette hashing is stable', () => {
  it('hash64 is a fixed function (cassettes on disk stay valid across machines)', () => {
    expect(hash64('')).toBe('488bdcb81aee8d83')
    expect(hash64('brush')).toBe('7cfd42d38ee3db7c')
    expect(hash64(canonicalJson({ b: [1, { d: 2, c: 'x' }], a: null }))).toBe('2eadf9ad8e4d94a3')
  })

  it('canonical JSON ignores key order and undefined members', () => {
    expect(canonicalJson({ b: 1, a: { y: 2, x: undefined, w: [3, 'z'] } })).toBe('{"a":{"w":[3,"z"],"y":2},"b":1}')
    expect(requestHash('hosted', 'm', { a: 1, b: 2 })).toBe(requestHash('hosted', 'm', { b: 2, a: 1 }))
    expect(requestHash('hosted', 'm', { a: 1 })).not.toBe(requestHash('local', 'm', { a: 1 }))
  })

  it.each(['local', 'hosted', 'jev'] as const)('%s: float noise below the rounding does not change the request hash', (adapter) => {
    const codec = codecFor(adapter)
    const p1 = samplePacket()
    const p2 = samplePacket()
    p2.features = { ...p2.features, lengthPt: p2.features.lengthPt + 1e-9, meanSpeed: p2.features.meanSpeed + 1e-7 }
    p2.nearest = [...p2.nearest].reverse() // nearest items are sorted by distance in the view
    expect(requestHash(adapter, codec.model, codec.buildRequest(p2))).toBe(requestHash(adapter, codec.model, codec.buildRequest(p1)))
    const p3 = samplePacket({ roomLabel: 'CORRIDOR' })
    expect(requestHash(adapter, codec.model, codec.buildRequest(p3))).not.toBe(requestHash(adapter, codec.model, codec.buildRequest(p1)))
  })
})

function cassetteFor(adapter: 'local' | 'hosted' | 'jev', latencyMs = 300): Cassette {
  const codec = codecFor(adapter)
  const body = codec.buildRequest(samplePacket())
  const hash = requestHash(adapter, codec.model, body)
  return {
    schema: CASSETTE_SCHEMA,
    adapter,
    model: codec.model,
    requestHash: hash,
    requestSummary: {},
    request: body,
    response: syntheticResponse(adapter, codec.model, oracleProbs(samplePacket(), 'wall', hash, { pCorrect: 1 })),
    latencyMs,
    recordedAt: 'test',
    synthetic: true,
  }
}

describe('M4-01 CassetteRescorer replays by request hash with simulated latency', () => {
  it('replays, waits the recorded latency (scaled), fuses and re-ranks', async () => {
    const waits: number[] = []
    const sleep: Sleep = async (ms) => void waits.push(ms)
    const r = new CassetteRescorer({ codec: codecFor('hosted'), cassettes: [cassetteFor('hosted', 400)], weight: 1, latencyScale: 0.5, sleep })
    const out = await r.rescore(samplePacket(), [sampleHypothesis()])
    expect(waits).toEqual([200])
    expect(out[0].kind).toBe('wall')
    expect(out[0].evidence?.at(-1)).toMatch(/second pass \(hosted/)
  })

  it('rejects with CassetteMissError on an unknown request', async () => {
    const r = new CassetteRescorer({ codec: codecFor('hosted'), cassettes: [cassetteFor('hosted')], weight: 0.5, sleep: async () => {} })
    await expect(r.rescore(samplePacket({ roomLabel: 'LOBBY' }), [sampleHypothesis()])).rejects.toBeInstanceOf(CassetteMissError)
  })

  it('ignores cassettes of other adapters/models and honours abort', async () => {
    const r = new CassetteRescorer({ codec: codecFor('local'), cassettes: [cassetteFor('hosted'), cassetteFor('local', 10_000)], weight: 0.5 })
    expect(r.byHash.size).toBe(1)
    const ctrl = new AbortController()
    const p = r.rescore(samplePacket(), [sampleHypothesis()], ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow(/aborted/)
  })
})
