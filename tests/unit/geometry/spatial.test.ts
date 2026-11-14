import { describe, expect, it } from 'vitest'
import type { ContextItem, Point } from '../../../src/core/types'
import { SpatialIndex, snapAngle, snapPoint } from '../../../src/core/geometry'
import { closestPointOnPolyline } from '../../../src/core/geometry/vec'
import { rng, wall } from './helpers'

function randomItems(n: number, seed: number, extent = 600): ContextItem[] {
  const r = rng(seed)
  const items: ContextItem[] = []
  for (let i = 0; i < n; i++) {
    const x = r() * extent
    const y = r() * extent
    const horiz = r() < 0.5
    const L = 10 + r() * 80
    const pts: Point[] = [{ x, y }, horiz ? { x: x + L, y } : { x, y: y + L }]
    if (r() < 0.3) pts.push({ x: pts[1].x + (r() - 0.5) * 40, y: pts[1].y + (r() - 0.5) * 40 })
    items.push(wall(`w${i}`, pts, i % 7 === 0 ? 'grid' : 'wall', 0.5 + r() * 0.5))
  }
  return items
}

const brute = (items: ContextItem[], p: Point) =>
  items
    .map((it) => ({ id: it.id, d: closestPointOnPolyline(p, it.geometry.points, it.geometry.closed).distance }))
    .sort((a, b) => a.d - b.d)

describe('SpatialIndex', () => {
  const items = randomItems(600, 42)
  const idx = new SpatialIndex(items)
  const r = rng(7)

  it('nearest(k) matches brute force', () => {
    for (let q = 0; q < 200; q++) {
      const p = { x: r() * 700 - 50, y: r() * 700 - 50 }
      const k = 1 + Math.floor(r() * 6)
      const got = idx.nearest(p, k)
      const want = brute(items, p).slice(0, k)
      expect(got.map((h) => h.distance)).toEqual(want.map((w) => expect.closeTo(w.d, 9)))
    }
  })

  it('nearest respects filter', () => {
    const p = { x: 300, y: 300 }
    const got = idx.nearest(p, 3, (it) => it.kind === 'grid')
    expect(got).toHaveLength(3)
    expect(got.every((h) => h.item.kind === 'grid')).toBe(true)
    const want = brute(items.filter((i) => i.kind === 'grid'), p).slice(0, 3)
    expect(got.map((h) => h.item.id)).toEqual(want.map((w) => w.id))
  })

  it('itemsNear matches brute force', () => {
    for (let q = 0; q < 100; q++) {
      const p = { x: r() * 600, y: r() * 600 }
      const rad = 5 + r() * 40
      const got = idx.itemsNear(p, rad).map((h) => h.item.id).sort()
      const want = brute(items, p).filter((b) => b.d <= rad).map((b) => b.id).sort()
      expect(got).toEqual(want)
    }
  })

  it('itemsInRect finds items touching the rect', () => {
    const rect = { x: 100, y: 100, w: 60, h: 40 }
    const got = idx.itemsInRect(rect).map((i) => i.id).sort()
    const want = items
      .filter((it) => it.geometry.points.some((p, i, a) => i < a.length - 1 && segHitsRect(p, a[i + 1], rect)))
      .map((i) => i.id)
      .sort()
    expect(got).toEqual(want)
  })

  it('queries on ~5000 segments stay well under 2 ms', () => {
    const big = new SpatialIndex(randomItems(3500, 5, 1200))
    expect(big.segmentCount).toBeGreaterThan(4000)
    const rr = rng(9)
    const times: number[] = []
    for (let i = 0; i < 300; i++) {
      const p = { x: rr() * 1200, y: rr() * 1200 }
      const t0 = performance.now()
      big.itemsNear(p, 8)
      big.nearest(p, 5)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[150]).toBeLessThan(2)
  })
})

function segHitsRect(a: Point, b: Point, r: { x: number; y: number; w: number; h: number }): boolean {
  // sample densely; fine for a test oracle
  for (let t = 0; t <= 1; t += 0.001) {
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true
  }
  return false
}

describe('snapPoint', () => {
  const walls = [
    wall('A', [{ x: 0, y: 100 }, { x: 300, y: 100 }]),
    wall('B', [{ x: 150, y: 0 }, { x: 150, y: 300 }]),
    wall('G', [{ x: 0, y: 250 }, { x: 300, y: 250 }], 'grid'),
    wall('lowconf', [{ x: 0, y: 200 }, { x: 300, y: 200 }], 'wall', 0.1),
  ]
  const idx = new SpatialIndex(walls)

  it('snaps to the intersection of two walls', () => {
    const s = snapPoint({ x: 153, y: 97 }, idx, { radius: 8 })
    expect(s.kind).toBe('intersection')
    expect(s.point).toEqual({ x: 150, y: 100 })
    expect(s.itemIds.sort()).toEqual(['A', 'B'])
    expect(s.distance).toBeCloseTo(Math.hypot(3, 3))
  })

  it('snaps to an endpoint', () => {
    const s = snapPoint({ x: 3, y: 102 }, idx, { radius: 8 })
    expect(s.kind).toBe('endpoint')
    expect(s.point).toEqual({ x: 0, y: 100 })
  })

  it('snaps onto a wall centerline and a grid line', () => {
    const w = snapPoint({ x: 70, y: 104 }, idx)
    expect(w.kind).toBe('on-wall')
    expect(w.point).toEqual({ x: 70, y: 100 })
    const g = snapPoint({ x: 70, y: 247 }, idx)
    expect(g.kind).toBe('on-grid')
    expect(g.point).toEqual({ x: 70, y: 250 })
  })

  it('returns none outside the radius', () => {
    const s = snapPoint({ x: 70, y: 170 }, idx)
    expect(s.kind).toBe('none')
    expect(s.point).toEqual({ x: 70, y: 170 })
  })

  it('wall/grid intersections are found', () => {
    const s = snapPoint({ x: 148, y: 252 }, idx)
    expect(s.kind).toBe('intersection')
    expect(s.point).toEqual({ x: 150, y: 250 })
  })

  it('angle snapping: axes, 45 and wall direction', () => {
    const a = snapAngle({ x: 0, y: 0 }, { x: 100, y: 3 })
    expect(a.snappedTo).toBe('axis')
    expect(a.point.y).toBeCloseTo(0)
    expect(Math.hypot(a.point.x, a.point.y)).toBeCloseTo(Math.hypot(100, 3))
    const d = snapAngle({ x: 0, y: 0 }, { x: 50, y: 53 })
    expect(d.angleRad).toBeCloseTo(Math.PI / 4)
    expect(snapAngle({ x: 0, y: 0 }, { x: 100, y: 30 }).snappedTo).toBe('none')
    const tilted = new SpatialIndex([wall('T', [{ x: 0, y: 0 }, { x: 100, y: 30 }])])
    const w = snapAngle({ x: 10, y: 3 }, { x: 110, y: 36 }, tilted)
    expect(w.snappedTo).toBe('wall')
    expect(w.itemId).toBe('T')
  })

  it('one snap decision with ~2000 items is under 2 ms (median)', () => {
    const items = randomItems(2000, 11, 1500)
    const big = new SpatialIndex(items)
    snapPoint({ x: 1, y: 1 }, big) // warm: builds intersection/endpoint tables
    const rr = rng(3)
    const times: number[] = []
    for (let i = 0; i < 400; i++) {
      const p = { x: rr() * 1500, y: rr() * 1500 }
      const t0 = performance.now()
      snapPoint(p, big, { radius: 8 })
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[200]).toBeLessThan(2)
  })
})
