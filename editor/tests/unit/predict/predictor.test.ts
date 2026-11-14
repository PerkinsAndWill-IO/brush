import { describe, expect, it } from 'vitest'
import { DECISION_KINDS, type DecisionKind, type Hypothesis } from '../../../src/core/types'
import { DEFAULT_PALETTE } from '../../../src/core/context'
import {
  KINDS_FOR_COARSE,
  StreamingPredictor,
  StrokeSession,
  buildContextPacket,
  chipsFor,
  groupStrokes,
  initialStability,
  mergeGesture,
  readGesture,
  shouldCommit,
  stabilityStep,
} from '../../../src/core/predict'
import {
  PT_PER_M,
  polyStroke,
  rectStroke,
  replayRecording,
  replayStroke,
  scannedContext,
  scribbleStroke,
  settings,
  testContext,
  trainRecordings,
} from './helpers'

const ctx = testContext()
const S = settings()

// A 6 m wall starting on wall-v, running right (slightly off-axis, to be snapped).
const wallStroke = () => polyStroke([{ x: 301.5, y: 150 }, { x: 301.5 + 6 * PT_PER_M, y: 152 }])
// A 0.9 m tick across wall-h.
const doorStroke = () => polyStroke([{ x: 450, y: 100 - 0.45 * PT_PER_M }, { x: 450.5, y: 100 + 0.45 * PT_PER_M }])
// A 1.75 x 0.88 m rectangle inside MEETING 101 (between Desk 1600x800 and Table 1800x900).
const furnitureStroke = () => rectStroke(60, 260, 1.75 * PT_PER_M, 0.88 * PT_PER_M)

const probs = (o: Partial<Record<DecisionKind, number>>): Record<DecisionKind, number> => ({ wall: 0, door: 0, furniture: 0, delete: 0, markup: 0, ...o })

describe('M3-02 refresh throttle and first hypothesis', () => {
  it('M3-02: the first update runs immediately and later runs are at least refreshMs apart in stroke time', () => {
    const stroke = wallStroke()
    const p = new StreamingPredictor()
    const first = p.update({ ...stroke, points: stroke.points.slice(0, 1) }, ctx, S)
    expect(first.run).toBe(1)
    expect(first.atMs).toBe(0)
    const { predictor } = replayStroke(stroke, ctx, S, new StreamingPredictor())
    const runs = predictor.hypotheses
    // one run per 50 ms of stroke time, plus the first and the flush
    const duration = stroke.points[stroke.points.length - 1].t
    expect(runs.length).toBeLessThanOrEqual(Math.floor(duration / S.refreshMs) + 2)
    for (let i = 1; i < runs.length - 1; i++) expect((runs[i].atMs ?? 0) - (runs[i - 1].atMs ?? 0)).toBeGreaterThanOrEqual(S.refreshMs)
  })

  it('M3-02: calls between runs return the cached hypothesis object', () => {
    const stroke = wallStroke()
    const p = new StreamingPredictor()
    const a = p.update({ ...stroke, points: stroke.points.slice(0, 1) }, ctx, S)
    const b = p.update({ ...stroke, points: stroke.points.slice(0, 3) }, ctx, S) // t = 16 ms < 50 ms
    expect(b).toBe(a)
    expect(p.isDue(stroke.points[2].t, S)).toBe(false)
    expect(p.isDue(50, S)).toBe(true)
  })
})

describe('M3-03 hypothesis content', () => {
  it('M3-03: a wall carries kind, snapped geometry, palette type, confidence and ranked alternatives', () => {
    const h = replayStroke(wallStroke(), ctx, S).final
    expect(h.kind).toBe('wall')
    expect(h.coarse).toBe('linear')
    expect(h.confidence).toBeGreaterThan(0.6)
    expect(h.confidence).toBeLessThanOrEqual(1)
    // start snapped onto wall-v, direction snapped to the horizontal axis
    expect(h.geometry.points[0].x).toBeCloseTo(300, 6)
    expect(h.geometry.points[1].y).toBeCloseTo(h.geometry.points[0].y, 6)
    expect(DEFAULT_PALETTE.walls.map((w) => w.name)).toContain(h.type)
    expect(h.alternatives.every((a) => a.kind !== h.kind)).toBe(true)
    for (let i = 1; i < h.alternatives.length; i++) expect(h.alternatives[i - 1].confidence).toBeGreaterThanOrEqual(h.alternatives[i].confidence)
    expect(h.evidence?.length).toBeGreaterThan(0)
  })

  it('M3-03: a tick across a wall is a door placed on the host wall, typed by width', () => {
    const h = replayStroke(doorStroke(), ctx, S).final
    expect(h.kind).toBe('door')
    expect(h.targets).toEqual(['wall-h'])
    expect(h.type).toBe('Single-Flush 0900x2100')
    for (const p of h.geometry.points) expect(p.y).toBeCloseTo(100, 6)
    const w = Math.abs(h.geometry.points[1].x - h.geometry.points[0].x)
    expect(w / PT_PER_M).toBeCloseTo(0.9, 2)
  })

  it('M3-03: a small closed rectangle in a meeting room is furniture, typed with the room prior (MEETING -> table)', () => {
    const h = replayStroke(furnitureStroke(), ctx, S).final
    expect(h.kind).toBe('furniture')
    expect(h.coarse).toBe('closed')
    expect(h.geometry.closed).toBe(true)
    expect(h.geometry.points).toHaveLength(4)
    expect(h.type).toMatch(/Table/)
    expect(h.evidence?.join(' ')).toMatch(/MEETING 101/)
  })

  it('M3-03: a scribble over a detected item is a delete targeting that item', () => {
    const h = replayStroke(scribbleStroke(96, 190, 50, 40, 6), ctx, S).final
    expect(h.kind).toBe('delete')
    expect(h.targets).toContain('fixture-1')
  })

  it('M3-03: an eraser stroke over an item is a delete', () => {
    const h = replayStroke(scribbleStroke(98, 198, 44, 24, 4, 'eraser'), ctx, S).final
    expect(h.kind).toBe('delete')
    expect(h.targets).toContain('fixture-1')
  })

  it('M3-03: a ring around a label is markup, and markup keeps the raw ink', () => {
    const ring = polyStroke(
      Array.from({ length: 41 }, (_, i) => ({ x: 440 + 28 * Math.cos((i / 40) * 2 * Math.PI), y: 303.5 + 9 * Math.sin((i / 40) * 2 * Math.PI) })),
    )
    const h = replayStroke(ring, ctx, S).final
    expect(h.kind).toBe('markup')
    expect(h.geometry.points.length).toBe(ring.points.length)
  })

  it('M3-03: scanned sheets fall back to shape alone', () => {
    const sc = scannedContext()
    const w = replayStroke(polyStroke([{ x: 100, y: 100 }, { x: 100 + 6 * PT_PER_M, y: 101 }]), sc, S).final
    expect(w.kind).toBe('wall')
    expect(w.evidence?.join(' ')).toMatch(/shape only/)
    expect(replayStroke(rectStroke(100, 300, 1.6 * PT_PER_M, 0.8 * PT_PER_M), sc, S).final.kind).toBe('furniture')
  })
})

describe('M3-04 coarse to fine', () => {
  const families: Record<string, string[]> = {
    wall: DEFAULT_PALETTE.walls.map((w) => w.name),
    door: DEFAULT_PALETTE.doors.map((d) => d.name),
    furniture: DEFAULT_PALETTE.furniture.map((f) => f.name),
  }
  const check = (hs: Hypothesis[]) => {
    for (const h of hs) {
      expect(h.coarse).toBeDefined()
      expect(KINDS_FOR_COARSE[h.coarse!]).toContain(h.kind)
      if (h.type !== undefined) expect(families[h.kind]).toContain(h.type)
      if (h.kind === 'markup' || h.kind === 'delete') expect(h.type).toBeUndefined()
    }
  }

  it('M3-04: every hypothesis of hand-built strokes has kind within its coarse class and type within its kind', () => {
    for (const s of [wallStroke(), doorStroke(), furnitureStroke(), scribbleStroke(96, 190, 50, 40, 6)]) check(replayStroke(s, ctx, S).predictor.hypotheses)
  })

  it('M3-04: the same holds over replayed corpus strokes (train split)', () => {
    for (const { rec, ctx: c } of trainRecordings(40)) check(replayRecording(rec, c, S))
  })
})

describe('M3-05 stability', () => {
  it('M3-05: a challenger must lead by switchMargin for switchRuns runs in a row', () => {
    let st = stabilityStep(initialStability(), probs({ wall: 0.7, markup: 0.3 }), 'wall', 0.15, 2).state
    expect(st.leader).toBe('wall')
    let r = stabilityStep(st, probs({ wall: 0.3, door: 0.5, markup: 0.2 }), 'door', 0.15, 2)
    expect(r.leader).toBe('wall')
    expect(r.settled).toBe(false)
    r = stabilityStep(r.state, probs({ wall: 0.3, door: 0.5, markup: 0.2 }), 'door', 0.15, 2)
    expect(r.leader).toBe('door')
    expect(r.switched).toBe(true)
    st = r.state
    // a lead below the margin never switches
    for (let i = 0; i < 5; i++) st = stabilityStep(st, probs({ door: 0.4, wall: 0.5, markup: 0.1 }), 'wall', 0.15, 2).state
    expect(st.leader).toBe('door')
  })

  it('M3-05: an interrupted challenger starts counting again', () => {
    let st = stabilityStep(initialStability(), probs({ wall: 0.7 }), 'wall', 0.15, 2).state
    st = stabilityStep(st, probs({ wall: 0.3, door: 0.6 }), 'door', 0.15, 2).state
    st = stabilityStep(st, probs({ wall: 0.6, door: 0.3 }), 'wall', 0.15, 2).state
    st = stabilityStep(st, probs({ wall: 0.3, door: 0.6 }), 'door', 0.15, 2).state
    expect(st.leader).toBe('wall')
    st = stabilityStep(st, probs({ wall: 0.3, door: 0.6 }), 'door', 0.15, 2).state
    expect(st.leader).toBe('door')
  })

  it('M3-05: in replayed strokes the leading kind never changes without a challenger run first (except forced switches)', () => {
    for (const { rec, ctx: c } of trainRecordings(30)) {
      const hs = replayRecording(rec, c, S)
      for (let i = 2; i < hs.length; i++) {
        const switched = hs[i].kind !== hs[i - 1].kind
        // a switch to a non-markup kind needs the previous run to have shown it as a pending challenger
        if (switched && !hs[i].evidence?.some((e) => e.startsWith('forced switch')))
          expect(hs[i - 1].evidence?.join(' ')).toContain(`${hs[i].kind} challenging`)
      }
    }
  })
})

describe('M3-08 confidence bands', () => {
  it('M3-08: chips show the top two between chipLow and chipHigh only', () => {
    const h = (confidence: number): Hypothesis => ({
      kind: 'wall',
      confidence,
      geometry: { points: [], closed: false },
      alternatives: [{ kind: 'door', confidence: 0.3 }],
      stable: true,
    })
    expect(chipsFor(h(0.5), S)).toEqual(['wall', 'door'])
    expect(chipsFor(h(0.35), S)).toEqual(['wall', 'door'])
    expect(chipsFor(h(0.6), S)).toEqual([])
    expect(chipsFor(h(0.8), S)).toEqual([])
  })

  it('M3-08: a non-markup reading always has confidence >= chipLow (below it, the ink stays markup)', () => {
    for (const { rec, ctx: c } of trainRecordings(50)) for (const h of replayRecording(rec, c, S)) if (h.kind !== 'markup') expect(h.confidence).toBeGreaterThanOrEqual(S.chipLow)
    // with an impossible chipLow nothing becomes an element
    const strict = settings({ chipLow: 0.99 })
    expect(replayStroke(wallStroke(), ctx, strict).final.kind).toBe('markup')
  })
})

describe('M3-06 / M3-07 commit and freeze', () => {
  it('M3-06: commit happens only after commitPauseMs without new points', () => {
    expect(shouldCommit(100, 499, S)).toBe(false)
    expect(shouldCommit(100, 500, S)).toBe(true)
    const stroke = wallStroke()
    const s = new StrokeSession({ ...stroke, points: [], startedAt: 1_000_000 }, ctx, S)
    for (const pt of stroke.points) {
      s.addPoint(pt)
      expect(s.tick(pt.t)).toBeNull()
    }
    const lastT = s.lastPointT
    expect(s.tick(lastT + 399)).toBeNull()
    const d = s.tick(lastT + 400)
    expect(d).not.toBeNull()
    expect(d!.kind).toBe('wall')
    expect(d!.committedAt).toBe(1_000_000 + lastT + 400)
    expect(d!.strokeId).toBe(stroke.id)
  })

  it('M3-06: addPoint reports a hypothesis only when a run happened', () => {
    const stroke = doorStroke()
    const s = new StrokeSession({ ...stroke, points: [] }, ctx, S)
    const runs = stroke.points.map((p) => s.addPoint(p)).filter((h) => h !== null)
    expect(runs.length).toBe(s.hypotheses.length)
    expect(runs[0]!.run).toBe(1)
  })

  it('M3-07: after commit the decision and hypothesis are frozen', () => {
    const stroke = doorStroke()
    const s = new StrokeSession({ ...stroke, points: [] }, ctx, S)
    for (const pt of stroke.points) s.addPoint(pt)
    s.end()
    const d = s.tick(s.lastPointT + 400)!
    const frozen = JSON.stringify(d)
    expect(s.addPoint({ x: 600, y: 600, t: s.lastPointT + 500 })).toBeNull()
    expect(s.tick(s.lastPointT + 5000)).toBeNull()
    expect(s.commit(123)).toBe(d)
    expect(JSON.stringify(s.committed)).toBe(frozen)
    // the predictor itself returns the frozen hypothesis for any later input
    const h = s.predictor.update(wallStroke(), ctx, S)
    expect(h.kind).toBe(d.kind)
    expect(h.stable).toBe(true)
    expect(s.predictor.flush(wallStroke(), ctx, S)).toBe(h)
  })
})

describe('M3-09 determinism', () => {
  it('M3-09: replaying the corpus twice gives identical hypotheses', () => {
    const recs = trainRecordings(40)
    const a = recs.map(({ rec, ctx: c }) => replayRecording(rec, c, S))
    const b = recs.map(({ rec, ctx: c }) => replayRecording(rec, c, S))
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('M3-09: reset() makes a used predictor behave like a fresh one', () => {
    const p = new StreamingPredictor()
    replayStroke(furnitureStroke(), ctx, S, p)
    p.reset()
    const again = replayStroke(wallStroke(), ctx, S, p).predictor.hypotheses
    const fresh = replayStroke(wallStroke(), ctx, S).predictor.hypotheses
    expect(JSON.stringify(again)).toBe(JSON.stringify(fresh))
  })
})

describe('mode forcing and narrowing', () => {
  it('a forced mode is the reading regardless of shape', () => {
    const h = replayStroke(wallStroke(), ctx, settings({ mode: 'door' })).final
    expect(h.kind).toBe('door')
    expect(h.confidence).toBe(1)
    expect(h.evidence?.join(' ')).toMatch(/mode forces door/)
    expect(replayStroke(wallStroke(), ctx, settings({ mode: 'markup' })).final.kind).toBe('markup')
  })

  it('allowedKinds narrows the options; markup stays available', () => {
    const h = replayStroke(wallStroke(), ctx, settings({ allowedKinds: ['furniture', 'door'] })).final
    expect(h.kind).not.toBe('wall')
    expect(h.alternatives.map((a) => a.kind)).not.toContain('wall')
    const ok = replayStroke(wallStroke(), ctx, settings({ allowedKinds: ['wall'] })).final
    expect(ok.kind).toBe('wall')
  })
})

describe('M3-11 gesture grouping', () => {
  it('M3-11: two strokes close in time and space form one gesture', () => {
    const a = polyStroke([{ x: 98, y: 198 }, { x: 142, y: 222 }], { id: 'a', startedAt: 1000 })
    const b = polyStroke([{ x: 142, y: 198 }, { x: 98, y: 222 }], { id: 'b', startedAt: 1000 + a.points[a.points.length - 1].t + 150 })
    const far = polyStroke([{ x: 500, y: 350 }, { x: 560, y: 350 }], { id: 'c', startedAt: b.startedAt! + 5000 })
    const groups = groupStrokes([a, b, far])
    expect(groups.map((g) => g.map((s) => s.id))).toEqual([['a', 'b'], ['c']])
    const m = mergeGesture(groups[0])
    expect(m.points.length).toBe(a.points.length + b.points.length)
    for (let i = 1; i < m.points.length; i++) expect(m.points[i].t).toBeGreaterThanOrEqual(m.points[i - 1].t)
    const h1 = readGesture(groups[0], ctx, S)
    const h2 = readGesture(groups[0], ctx, S)
    expect(h2).toEqual(h1)
    expect(['wall', 'door']).not.toContain(h1.kind)
  })
})

describe('context packet (M4 input)', () => {
  it('carries features, at most 8 nearest items, room, scale, last 3 accepted and the candidates', () => {
    const { predictor, final } = replayStroke(furnitureStroke(), ctx, S)
    const history = [1, 2, 3, 4].map((i) => ({
      strokeId: `s${i}`,
      sheetId: 'sheet-0',
      kind: 'wall' as const,
      geometry: { points: [], closed: false },
      confidence: 0.9,
      committedAt: i,
    }))
    const pk = buildContextPacket({ stroke: furnitureStroke(), ctx, evidence: predictor.lastTrace?.evidence }, final, history)
    expect(pk.nearest.length).toBeLessThanOrEqual(8)
    expect(pk.nearest.length).toBeGreaterThan(0)
    expect(pk.roomLabel).toBe('MEETING 101')
    expect(pk.scale).toBe(100)
    expect(pk.history.map((h) => h.strokeId)).toEqual(['s2', 's3', 's4'])
    expect(pk.candidates[0]).toEqual({ kind: final.kind, confidence: final.confidence })
    expect(pk.candidates.map((c) => c.kind).sort()).toEqual([...new Set(pk.candidates.map((c) => c.kind))].sort())
    expect(DECISION_KINDS).toContain(pk.candidates[1]?.kind ?? 'markup')
    expect(pk.features.lengthPt).toBeGreaterThan(0)
  })
})
