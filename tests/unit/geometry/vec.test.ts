import { describe, expect, it } from 'vitest'
import {
  angleDiffMod,
  bbox,
  closestPointOnPolyline,
  closestPointOnSegment,
  polygonArea,
  polygonContains,
  polylineLength,
  rotate,
  segmentDistance,
  segmentIntersection,
} from '../../../src/core/geometry'

describe('vec', () => {
  it('segment distance and closest point clamp to ends', () => {
    expect(segmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3)
    expect(closestPointOnSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }).point).toEqual({ x: 0, y: 0 })
  })
  it('closest point on polyline', () => {
    const r = closestPointOnPolyline({ x: 12, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    expect(r.segIndex).toBe(1)
    expect(r.point).toEqual({ x: 10, y: 5 })
    expect(r.distance).toBe(2)
  })
  it('segment intersection', () => {
    const x = segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })
    expect(x?.point).toEqual({ x: 5, y: 5 })
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeNull()
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: -1 }, { x: 2, y: 1 })).toBeNull()
  })
  it('polygon area / contains / bbox / length', () => {
    const sq = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }]
    expect(polygonArea(sq)).toBe(12)
    expect(polygonContains(sq, { x: 2, y: 1 })).toBe(true)
    expect(polygonContains(sq, { x: 5, y: 1 })).toBe(false)
    expect(bbox(sq)).toEqual({ x: 0, y: 0, w: 4, h: 3 })
    expect(polylineLength(sq, true)).toBe(14)
  })
  it('angleDiffMod treats opposite directions as parallel', () => {
    expect(angleDiffMod(0, Math.PI)).toBeCloseTo(0)
    expect(angleDiffMod(0.1, Math.PI - 0.1)).toBeCloseTo(0.2)
    expect(angleDiffMod(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2)
  })
  it('rotate', () => {
    const r = rotate({ x: 1, y: 0 }, Math.PI / 2)
    expect(r.x).toBeCloseTo(0)
    expect(r.y).toBeCloseTo(1)
  })
})
