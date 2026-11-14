import { describe, expect, it } from 'vitest'
import { DECISION_KINDS } from '@core/types'
import { DEFAULT_RESCORE_SETTINGS, firstPassProbs, fuse, normalizeProbs, resolveAnswer, shouldRescore, toHypotheses, topMargin } from '@core/rescore'
import { samplePacket, sampleHypothesis } from './helpers'

const first = normalizeProbs({ wall: 0.41, door: 0.52, markup: 0.07 })
const model = normalizeProbs({ wall: 0.8, door: 0.1, markup: 0.1 })

describe('M4 fusion (weighted log-linear)', () => {
  it('w = 0 leaves the first pass unchanged (model removable)', () => {
    const f = fuse(first, model, 0)
    for (const k of DECISION_KINDS) expect(f[k]).toBeCloseTo(first[k], 12)
  })

  it('w = 1 is the model alone; w = 0.5 is the normalised geometric mean', () => {
    const one = fuse(first, model, 1)
    for (const k of DECISION_KINDS) expect(one[k]).toBeCloseTo(model[k], 12)
    const half = fuse(first, model, 0.5)
    const g = Object.fromEntries(DECISION_KINDS.map((k) => [k, Math.sqrt(first[k] * model[k])]))
    const z = Object.values(g).reduce((a, b) => a + b, 0)
    for (const k of DECISION_KINDS) expect(half[k]).toBeCloseTo(g[k] / z, 12)
    expect(half.wall).toBeGreaterThan(half.door) // the model nudged wall over door
  })

  it('clamps out-of-range weights and stays a distribution', () => {
    const f = fuse(first, model, 7)
    expect(Object.values(f).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
    expect(fuse(first, model, NaN).door).toBeCloseTo(first.door, 12)
  })

  it('firstPassProbs floors missing kinds', () => {
    const p = firstPassProbs(samplePacket().candidates)
    expect(p.furniture).toBeGreaterThan(0)
    expect(p.door).toBeGreaterThan(p.wall)
  })

  it('toHypotheses re-ranks, keeps geometry/run, lists the others as alternatives, adds an evidence line', () => {
    const h = sampleHypothesis()
    const out = toHypotheses(fuse(first, model, 0.5), [h], 'second pass: x')
    expect(out.map((x) => x.kind)[0]).toBe('wall')
    expect(out).toHaveLength(5)
    expect(out[0].geometry).toBe(h.geometry)
    expect(out[0].run).toBe(7)
    expect(out[0].alternatives.map((a) => a.kind)).not.toContain('wall')
    expect(out[0].alternatives[0].kind).toBe('door')
    expect(out[0].evidence).toEqual(['short line crossing a wall', 'second pass: x'])
    expect(toHypotheses(first, [])).toEqual([])
  })
})

describe('M4 ambiguity policy', () => {
  const s = { ...DEFAULT_RESCORE_SETTINGS, adapter: 'hosted' as const }
  it('calls the model only when top confidence < 0.6 or the top-2 margin < 0.15', () => {
    expect(shouldRescore(sampleHypothesis({ confidence: 0.52 }), s)).toBe(true)
    expect(shouldRescore(sampleHypothesis({ confidence: 0.9, alternatives: [{ kind: 'wall', confidence: 0.05 }] }), s)).toBe(false)
    expect(shouldRescore(sampleHypothesis({ confidence: 0.62, alternatives: [{ kind: 'wall', confidence: 0.55 }] }), s)).toBe(true)
    expect(topMargin([{ kind: 'wall', confidence: 0.3 }, { kind: 'door', confidence: 0.7 }])).toBeCloseTo(0.4)
  })
  it('never calls when the adapter is off', () => {
    expect(shouldRescore(sampleHypothesis({ confidence: 0.1 }), DEFAULT_RESCORE_SETTINGS)).toBe(false)
  })
})

describe('M4-04 engine rule 6: late answers only add a suggestion chip', () => {
  const answer = { strokeId: 's1', run: 7, hypotheses: toHypotheses(normalizeProbs({ wall: 0.8, door: 0.2 }), [sampleHypothesis()]) }
  const s = { suggestMin: 0.5 }

  it('applies to the live hypothesis before commit, on the same run', () => {
    const a = resolveAnswer(answer, { strokeId: 's1', run: 7 }, s)
    expect(a.action).toBe('apply')
    if (a.action === 'apply') expect(a.hypothesis.kind).toBe('wall')
  })
  it('drops a stale answer when the stroke has moved on to newer runs', () => {
    expect(resolveAnswer(answer, { strokeId: 's1', run: 9 }, s)).toEqual({ action: 'drop', reason: 'stale' })
    expect(resolveAnswer(answer, { strokeId: 's2', run: 7 }, s)).toEqual({ action: 'drop', reason: 'other-stroke' })
  })
  it('after commit: a different, confident answer becomes a chip; never re-decides', () => {
    const a = resolveAnswer(answer, { strokeId: 's1', run: 7, committed: { strokeId: 's1', kind: 'door' } }, s)
    expect(a).toEqual({ action: 'suggest', chip: { kind: 'wall', confidence: answer.hypotheses[0].confidence }, strokeId: 's1' })
  })
  it('after commit: agreeing or weak answers are dropped', () => {
    expect(resolveAnswer(answer, { strokeId: 's1', run: 7, committed: { strokeId: 's1', kind: 'wall' } }, s).action).toBe('drop')
    expect(resolveAnswer(answer, { strokeId: 's1', run: 7, committed: { strokeId: 's1', kind: 'door' } }, { suggestMin: 0.95 })).toEqual({ action: 'drop', reason: 'weak' })
    expect(resolveAnswer({ ...answer, hypotheses: [] }, { strokeId: 's1', run: 7 }, s)).toEqual({ action: 'drop', reason: 'empty' })
  })
})
