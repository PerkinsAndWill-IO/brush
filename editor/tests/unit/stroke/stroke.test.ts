import { describe, expect, it } from 'vitest'
import { appendPoint, createStroke, extractFeatures, groupStrokes } from '../../../src/core/stroke'
import type { Stroke } from '../../../src/core/types'
import { arcPoints, densify, timed } from '../geometry/helpers'

const mk = (id: string, pts: ReturnType<typeof densify>, startedAt?: number): Stroke =>
  createStroke(id, 's1', { points: timed(pts), startedAt })

describe('model', () => {
  it('appendPoint zeroes first t and keeps time monotone', () => {
    const s = createStroke('a', 's1', { size: 3 })
    appendPoint(s, { x: 0, y: 0, t: 50 })
    appendPoint(s, { x: 1, y: 0, t: 40 })
    appendPoint(s, { x: 2, y: 0, t: 10, p: 0.5 })
    expect(s.points.map((p) => p.t)).toEqual([0, 40, 40])
    expect(s.points[2].p).toBe(0.5)
    expect(s.size).toBe(3)
  })

  it('groupStrokes groups by time and space', () => {
    const a = mk('a', densify([{ x: 0, y: 0 }, { x: 50, y: 0 }], 5), 1000) // duration ~80 ms
    const b = mk('b', densify([{ x: 55, y: 10 }, { x: 100, y: 10 }], 5), 1300)
    const far = mk('far', densify([{ x: 500, y: 500 }, { x: 550, y: 500 }], 5), 1400)
    const late = mk('late', densify([{ x: 60, y: 5 }, { x: 90, y: 5 }], 5), 9000)
    const g = groupStrokes([a, b, far, late], { maxGapMs: 500, maxDistPt: 30 })
    expect(g.map((x) => x.map((s) => s.id))).toEqual([['a', 'b'], ['far'], ['late']])
    expect(groupStrokes([])).toEqual([])
  })
})

describe('extractFeatures', () => {
  it('lengths in metres at 1:100 (72 pt = 1 in = 25.4 mm paper = 2.54 m real)', () => {
    const s = mk('l', [{ x: 0, y: 0 }, { x: 72, y: 0 }])
    const f = extractFeatures(s, { scale: 100 })
    expect(f.lengthPt).toBeCloseTo(72)
    expect(f.lengthM).toBeCloseTo(2.54, 6)
    expect(f.bboxM?.w).toBeCloseTo(2.54, 6)
    expect(f.bboxM?.h).toBe(0)
    expect(extractFeatures(s, { scale: 50 }).lengthM).toBeCloseTo(1.27, 6)
    const none = extractFeatures(s)
    expect(none.lengthM).toBeUndefined()
    expect(none.bboxM).toBeUndefined()
  })

  it('line: best fit line, not closed, no corners, 16-sample profiles', () => {
    const s = mk('l', densify([{ x: 0, y: 0 }, { x: 200, y: 20 }], 4, 0.8))
    const f = extractFeatures(s, { scale: 100, smoothing: 0.3 })
    expect(f.fits[0].kind).toBe('line')
    expect(f.closed).toBe(false)
    expect(f.cornerCount).toBe(0)
    expect(f.selfIntersections).toBe(0)
    expect(f.speedProfile).toHaveLength(16)
    expect(f.pressureProfile).toEqual([])
    expect(f.durationMs).toBeGreaterThan(0)
    expect(f.meanSpeed).toBeCloseTo(f.lengthPt / f.durationMs)
    expect(f.reversalDensity).toBe(0)
  })

  it('pressure profile resampled when every point has pressure', () => {
    const s = createStroke('p', 's1', {
      points: Array.from({ length: 30 }, (_, i) => ({ x: i, y: 0, t: i * 10, p: i / 29 })),
    })
    const f = extractFeatures(s)
    expect(f.pressureProfile).toHaveLength(16)
    expect(f.pressureProfile[0]).toBe(0)
    expect(f.pressureProfile[15]).toBeCloseTo(1)
  })

  it('L shape has one corner; circle is closed with no corners', () => {
    const L = extractFeatures(mk('L', densify([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }], 3, 0.4)))
    expect(L.cornerCount).toBe(1)
    expect(L.fits[0].kind).toBe('polyline')
    const C = extractFeatures(mk('C', arcPoints(0, 0, 50, 0, Math.PI * 2 * 0.99, 80, 0.3)))
    expect(C.closed).toBe(true)
    expect(C.cornerCount).toBe(0)
    expect(C.closureRatio).toBeLessThan(0.1)
  })

  it('zigzag has high reversal density; self-intersections counted for a figure 8-ish cross', () => {
    const zz = [{ x: 0, y: 0 }]
    for (let i = 0; i < 8; i++) zz.push({ x: (i + 1) * 12, y: i % 2 === 0 ? 40 : 0 })
    const f = extractFeatures(mk('z', densify(zz, 3, 0.2)))
    expect(f.fits[0].kind).toBe('scribble')
    expect(f.reversalDensity).toBeGreaterThan(1)
    const X = extractFeatures(mk('x', densify([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }], 4)))
    expect(X.selfIntersections).toBeGreaterThanOrEqual(1)
  })

  it('is fast: < 1 ms (median) for a 300-point stroke', () => {
    const s = mk('big', densify([{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 5 }], 1.7, 0.5))
    const pts = s.points.slice(0, 300)
    expect(pts.length).toBeGreaterThanOrEqual(290)
    const stroke = { ...s, points: pts }
    for (let i = 0; i < 20; i++) extractFeatures(stroke, { scale: 100, smoothing: 0.5 })
    // Best median of 5 batches: measures the code, not CPU contention from parallel test files.
    const medians: number[] = []
    for (let b = 0; b < 5; b++) {
      const times: number[] = []
      for (let i = 0; i < 100; i++) {
        const t0 = performance.now()
        extractFeatures(stroke, { scale: 100, smoothing: 0.5 })
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      medians.push(times[50])
    }
    expect(Math.min(...medians)).toBeLessThan(1)
  })

  it('handles degenerate strokes', () => {
    expect(extractFeatures(createStroke('e', 's1')).fits).toEqual([])
    const dot = extractFeatures(createStroke('d', 's1', { points: [{ x: 1, y: 1, t: 0 }] }))
    expect(dot.lengthPt).toBe(0)
    expect(dot.closed).toBe(false)
  })
})
