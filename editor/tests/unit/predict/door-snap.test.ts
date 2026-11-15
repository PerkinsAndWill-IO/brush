import { describe, expect, it } from 'vitest'
import type { Point } from '../../../src/core/types'
import { PT_PER_M, polyStroke, replayStroke, settings, testContext } from './helpers'

const ctx = testContext()
const doorMode = settings({ mode: 'door' })

// Quarter arc (door swing) from `hinge + r*u0` to `hinge + r*u1`, sampled as a polyline.
function arc(hinge: Point, r: number, a0: number, a1: number, n = 24): Point[] {
  const out: Point[] = []
  for (let i = 0; i <= n; i++) {
    const t = a0 + ((a1 - a0) * i) / n
    out.push({ x: hinge.x + r * Math.cos(t), y: hinge.y + r * Math.sin(t) })
  }
  return out
}

const onWallV = (p: Point) => expect(p.x).toBeCloseTo(300, 6)
const widthM = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y) / PT_PER_M

describe('M3-03 doors snap to the nearest wall', () => {
  it('M3-03: a slanted door tick drawn beside a wall (not across it) lands on the wall, aligned with it', () => {
    // 0.9 m line roughly along wall-v, 5 pt off and ~8 degrees off its direction
    const L = 0.9 * PT_PER_M
    const s = polyStroke([{ x: 305, y: 200 }, { x: 305 + L * Math.sin(8 * Math.PI / 180), y: 200 + L * Math.cos(8 * Math.PI / 180) }])
    const h = replayStroke(s, ctx, doorMode).final
    expect(h.kind).toBe('door')
    expect(h.targets).toEqual(['wall-v'])
    for (const p of h.geometry.points) onWallV(p)
    expect(widthM(h.geometry.points[0], h.geometry.points[1])).toBeCloseTo(0.9, 2)
  })

  it('M3-03: a door swing whose hinge is near (not on) a wall lands on the wall, opening along it', () => {
    // hinge 6 pt right of wall-v, swing into the room on the right, slightly rotated
    const r = 0.9 * PT_PER_M
    const rot = 10 * Math.PI / 180
    const s = polyStroke(arc({ x: 306, y: 200 }, r, Math.PI / 2 + rot, rot))
    const h = replayStroke(s, ctx, doorMode).final
    expect(h.kind).toBe('door')
    expect(h.targets).toEqual(['wall-v'])
    for (const p of h.geometry.points) onWallV(p)
    // the opening runs between the hinge and the closed leaf's tip on the wall
    const ys = h.geometry.points.map((p) => p.y).sort((m, n) => m - n)
    expect(ys[0]).toBeCloseTo(200, 0)
    expect(widthM(h.geometry.points[0], h.geometry.points[1])).toBeCloseTo(0.9, 2)
  })

  it('M3-03: a door drawn far from any wall keeps its drawn position', () => {
    const s = polyStroke([{ x: 120, y: 300 }, { x: 120 + 0.9 * PT_PER_M, y: 302 }])
    const h = replayStroke(s, ctx, doorMode).final
    expect(h.kind).toBe('door')
    expect(h.targets).toBeUndefined()
    expect(h.geometry.points[0].x).toBeCloseTo(120, 6)
  })
})
