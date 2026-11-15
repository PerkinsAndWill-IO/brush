import { describe, expect, it } from 'vitest'
import type { Point } from '../../../src/core/types'
import { PT_PER_M, polyStroke, replayStroke, scannedContext, settings, testContext } from './helpers'

const ctx = testContext()
const S = settings()
const WALL_Y = 100

/** Arc around `c` from angle a0, sweeping `sweep` radians (first vertex excluded). */
function arc(c: Point, r: number, a0: number, sweep: number, n = 12): Point[] {
  const out: Point[] = []
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
  }
  return out
}

/**
 * One stroke drawing a double door hinged on wall-h (y = 100): left leaf out, arc back to the middle,
 * arc out to the right leaf's tip, right leaf back to the wall. `dir` -1 draws it above the wall, +1 below.
 */
function doubleDoor(x0: number, widthM: number, o: { dir?: 1 | -1; leaves?: boolean; wobble?: number } = {}): Point[] {
  const dir = o.dir ?? -1
  const r = (widthM / 2) * PT_PER_M
  const L = { x: x0, y: WALL_Y }
  const R = { x: x0 + 2 * r, y: WALL_Y }
  const leaves = o.leaves ?? true
  const up = dir * (Math.PI / 2)
  const v: Point[] = [
    ...(leaves ? [L] : []),
    { x: x0, y: WALL_Y + dir * r },
    ...arc(L, r, up, -dir * (Math.PI / 2)), // to the meeting point at the middle
    ...arc(R, r, Math.PI, -dir * (Math.PI / 2)), // to the right leaf's tip
    ...(leaves ? [R] : []),
  ]
  // a shaky hand: deterministic sideways jitter
  const w = o.wobble ?? 0
  return v.map((p, i) => (i === 0 || i === v.length - 1 ? p : { x: p.x + w * Math.sin(i * 1.7), y: p.y + w * Math.cos(i * 2.3) }))
}

const width = (pts: Point[]) => Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / PT_PER_M

describe('M3-03 double door', () => {
  it('M3-03: two swings meeting in the middle are one double door on the host wall, centred between the hinges', () => {
    const h = replayStroke(polyStroke(doubleDoor(380, 1.8)), ctx, S).final
    expect(h.kind).toBe('door')
    expect(h.type).toBe('Double-Flush 1800x2100')
    expect(h.targets).toEqual(['wall-h'])
    for (const p of h.geometry.points) expect(p.y).toBeCloseTo(WALL_Y, 6)
    expect(width(h.geometry.points)).toBeCloseTo(1.8, 2)
    const mid = (h.geometry.points[0].x + h.geometry.points[1].x) / 2
    expect(mid).toBeCloseTo(380 + 0.9 * PT_PER_M, 1)
  })

  it.each([
    ['below the wall', { dir: 1 as const }],
    ['with a shaky hand', { wobble: 1.2 }],
  ])('M3-03: a double door drawn %s is a double door', (_name, o) => {
    const h = replayStroke(polyStroke(doubleDoor(380, 1.8, o)), ctx, S).final
    expect(h.kind).toBe('door')
    expect(h.type).toBe('Double-Flush 1800x2100')
    expect(h.targets).toEqual(['wall-h'])
  })

  it('M3-03: a double door drawn right to left is the same door', () => {
    const h = replayStroke(polyStroke(doubleDoor(380, 1.8).reverse()), ctx, S).final
    expect(h.kind).toBe('door')
    expect(h.type).toBe('Double-Flush 1800x2100')
  })

  it('M3-03: slanted leaves and a narrower pair (as sketched) still read as a double door', () => {
    // leaves leaning outwards, arcs not quite quarter circles, 1.6 m wide
    const r = 0.8 * PT_PER_M
    const x0 = 380
    const v: Point[] = [
      { x: x0, y: WALL_Y },
      { x: x0 - 3, y: WALL_Y - r * 0.95 },
      ...arc({ x: x0, y: WALL_Y }, r, -Math.PI / 2 - 0.05, Math.PI / 2 + 0.05),
      ...arc({ x: x0 + 2 * r, y: WALL_Y }, r, Math.PI, Math.PI / 2 - 0.1),
      { x: x0 + 2 * r + 4, y: WALL_Y - r * 0.9 },
      { x: x0 + 2 * r, y: WALL_Y },
    ]
    const h = replayStroke(polyStroke(v, { step: 1.5 }), ctx, S).final
    expect(h.kind).toBe('door')
    expect(h.type).toBe('Double-Flush 1800x2100')
  })

  it('M3-03: without sheet context the shape alone still reads as a door', () => {
    const h = replayStroke(polyStroke(doubleDoor(380, 1.8)), scannedContext(), S).final
    expect(h.kind).toBe('door')
  })

  it('M3-03: a single swing (leaf plus quarter arc) is not read as a pair', () => {
    const r = 0.9 * PT_PER_M
    const L = { x: 380, y: WALL_Y }
    const v: Point[] = [L, { x: 380, y: WALL_Y - r }, ...arc(L, r, -Math.PI / 2, Math.PI / 2)]
    const h = replayStroke(polyStroke(v), ctx, S).final
    expect(h.type).not.toMatch(/Double/)
  })
})
