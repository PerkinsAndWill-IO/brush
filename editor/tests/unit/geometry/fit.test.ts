import { describe, expect, it } from 'vitest'
import { fitPrimitives, detectCorners, simplifyDP, resampleByCount, resampleBySpacing, smoothMovingAverage, smoothChaikin } from '../../../src/core/geometry'
import { prepareForFit, reversalCount } from '../../../src/core/geometry/fit'
import { polylineLength } from '../../../src/core/geometry/vec'
import { arcPoints, densify } from './helpers'

const best = (pts: ReturnType<typeof densify>) => fitPrimitives(pts)[0]

describe('fitPrimitives', () => {
  it('noisy straight line -> line with high score', () => {
    const pts = densify([{ x: 10, y: 10 }, { x: 210, y: 70 }], 4, 1)
    const f = best(pts)
    expect(f.kind).toBe('line')
    expect(f.score).toBeGreaterThan(0.8)
    expect(f.path.points).toHaveLength(2)
  })

  it('L shape -> polyline with exactly 1 corner', () => {
    const pts = densify([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }], 3, 0.5)
    const f = best(pts)
    expect(f.kind).toBe('polyline')
    expect(f.path.points).toHaveLength(3)
    expect(detectCorners(pts)).toHaveLength(1)
    const v = f.path.points[1]
    expect(Math.hypot(v.x - 0, v.y - 100)).toBeLessThan(6)
  })

  it('quarter arc -> arc with sweep ~90deg', () => {
    const pts = arcPoints(0, 0, 100, 0, Math.PI / 2, 40, 0.5)
    const f = best(pts)
    expect(f.kind).toBe('arc')
    expect(f.score).toBeGreaterThan(0.7)
    expect(f.path.closed).toBe(false)
  })

  it('gentle curve under 20 degrees of sweep is not an arc', () => {
    const pts = arcPoints(0, 0, 300, 0, 0.2, 30)
    expect(fitPrimitives(pts).find((f) => f.kind === 'arc')).toBeUndefined()
    expect(best(pts).kind).toBe('line')
  })

  it('hand-drawn rectangle -> rectangle', () => {
    const pts = densify(
      [{ x: 0, y: 0 }, { x: 160, y: 2 }, { x: 158, y: 100 }, { x: 1, y: 98 }, { x: 2, y: 4 }],
      4,
      1,
    )
    const f = best(pts)
    expect(f.kind).toBe('rectangle')
    expect(f.score).toBeGreaterThan(0.7)
    expect(f.path.points).toHaveLength(4)
    expect(f.path.closed).toBe(true)
  })

  it('circle -> closed arc or blob, not rectangle', () => {
    const pts = arcPoints(50, 50, 40, 0, Math.PI * 2 * 0.99, 60, 0.5)
    const fits = fitPrimitives(pts)
    expect(['arc', 'blob']).toContain(fits[0].kind)
    expect(fits[0].path.closed).toBe(true)
    const rect = fits.find((f) => f.kind === 'rectangle')
    expect(rect ? rect.score : 0).toBeLessThan(fits[0].score)
  })

  it('zigzag scribble -> scribble beats polyline', () => {
    const zz = [{ x: 0, y: 0 }]
    for (let i = 0; i < 8; i++) zz.push({ x: (i + 1) * 12, y: i % 2 === 0 ? 40 : 0 })
    const pts = densify(zz, 3, 0.3)
    const fits = fitPrimitives(pts)
    expect(fits[0].kind).toBe('scribble')
    expect(fits[0].score).toBeGreaterThan(0.9)
  })

  it('degenerate input yields no fits', () => {
    expect(fitPrimitives([])).toEqual([])
    expect(fitPrimitives([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toEqual([])
  })

  it('fits are sorted by descending score, all in 0..1', () => {
    const fits = fitPrimitives(densify([{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 80 }], 3))
    for (let i = 1; i < fits.length; i++) expect(fits[i - 1].score).toBeGreaterThanOrEqual(fits[i].score)
    for (const f of fits) expect(f.score >= 0 && f.score <= 1).toBe(true)
  })
})

describe('resample / simplify / smooth', () => {
  const line = densify([{ x: 0, y: 0 }, { x: 100, y: 0 }], 1)
  it('resampleByCount keeps endpoints and even spacing', () => {
    const r = resampleByCount(line, 11)
    expect(r).toHaveLength(11)
    expect(r[0]).toEqual({ x: 0, y: 0 })
    expect(r[10].x).toBeCloseTo(100)
    expect(r[5].x).toBeCloseTo(50)
  })
  it('resampleBySpacing', () => {
    const r = resampleBySpacing(line, 10)
    expect(r).toHaveLength(11)
    expect(r[3].x).toBeCloseTo(30)
  })
  it('Douglas-Peucker removes collinear points but keeps the corner', () => {
    const s = simplifyDP(densify([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], 2), 0.5)
    expect(s).toHaveLength(3)
  })
  it('smoothing preserves endpoints and reduces length of noisy lines', () => {
    const noisy = densify([{ x: 0, y: 0 }, { x: 100, y: 0 }], 2, 2)
    for (const sm of [smoothMovingAverage(noisy, 0.8), smoothChaikin(noisy, 1)]) {
      expect(sm[0]).toEqual(noisy[0])
      expect(sm[sm.length - 1]).toEqual(noisy[noisy.length - 1])
      expect(polylineLength(sm)).toBeLessThan(polylineLength(noisy))
    }
    expect(smoothMovingAverage(noisy, 0)).toEqual(noisy)
  })
})

describe('reversal counting on dense scribbles', () => {
  it('counts the zigs of a tightly stacked zigzag (10 zigs in a 44x24 box)', () => {
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= 10; i++) {
      const y = i * 2.4
      const x = i % 2 === 0 ? 0 : 44
      pts.push({ x, y })
    }
    // densify
    const dense: { x: number; y: number }[] = []
    for (let i = 0; i < pts.length - 1; i++)
      for (let k = 0; k < 20; k++) dense.push({ x: pts[i].x + ((pts[i + 1].x - pts[i].x) * k) / 20, y: pts[i].y + ((pts[i + 1].y - pts[i].y) * k) / 20 })
    dense.push(pts[pts.length - 1])
    const prep = prepareForFit(dense)!
    expect(reversalCount(prep)).toBeGreaterThanOrEqual(7)
  })
})
