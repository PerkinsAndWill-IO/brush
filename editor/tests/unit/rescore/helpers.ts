import type { ContextPacket, Hypothesis } from '@core/types'

/** A small hand-built packet: a short stroke near a wall in an office, door vs wall ambiguous. */
export function samplePacket(over: Partial<ContextPacket> = {}): ContextPacket {
  return {
    features: {
      fits: [
        { kind: 'line', path: { points: [{ x: 100, y: 200 }, { x: 125, y: 200 }], closed: false }, residual: 0.4, score: 0.91 },
        { kind: 'arc', path: { points: [], closed: false }, residual: 2, score: 0.3 },
      ],
      lengthPt: 25.3,
      bbox: { x: 100, y: 198, w: 25.3, h: 4 },
      lengthM: 0.893,
      bboxM: { w: 0.89, h: 0.14 },
      closureRatio: 1,
      closed: false,
      cornerCount: 0,
      selfIntersections: 0,
      durationMs: 213.4,
      meanSpeed: 0.1186,
      speedProfile: [],
      pressureProfile: [],
      reversalDensity: 0,
    },
    nearest: [
      { id: 'w1', kind: 'wall', geometry: { points: [{ x: 90, y: 205 }, { x: 300, y: 205 }], closed: false }, confidence: 1 },
      { id: 'l1', kind: 'label', geometry: { points: [{ x: 150, y: 260 }], closed: false }, text: 'OFFICE 201', confidence: 1 },
    ],
    roomLabel: 'OFFICE 201',
    scale: 100,
    history: [{ strokeId: 's0', sheetId: 'sheet-0', kind: 'wall', geometry: { points: [], closed: false }, confidence: 0.9, committedAt: 1 }],
    candidates: [
      { kind: 'door', confidence: 0.52 },
      { kind: 'wall', confidence: 0.41 },
      { kind: 'markup', confidence: 0.07 },
    ],
    ...over,
  }
}

export function sampleHypothesis(over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    kind: 'door',
    geometry: { points: [{ x: 100, y: 200 }, { x: 125, y: 200 }], closed: false },
    confidence: 0.52,
    alternatives: [
      { kind: 'wall', confidence: 0.41 },
      { kind: 'markup', confidence: 0.07 },
    ],
    stable: false,
    run: 7,
    evidence: ['short line crossing a wall'],
    ...over,
  }
}
