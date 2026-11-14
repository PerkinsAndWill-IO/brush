import { describe, expect, it } from 'vitest'
import type { Point, SheetContext } from '../../../src/core/types'
import { DEFAULT_PALETTE, type TypePalette } from '../../../src/core/context'
import { gatherEvidence } from '../../../src/core/predict'
import { shapeFor } from '../../../src/core/predict/shape'
import { PT_PER_M, polyStroke, rectStroke, settings, testContext } from './helpers'

const S = settings()

/** A closed square outline of side `side` pt centred on `c`, turned by `deg`. */
function tiltedSquare(c: Point, side: number, deg: number) {
  const a = (deg * Math.PI) / 180
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ].map(([u, v]) => ({ x: c.x + (side / 2) * (u * Math.cos(a) - v * Math.sin(a)), y: c.y + (side / 2) * (u * Math.sin(a) + v * Math.cos(a)) }))
  return polyStroke(corners)
}

const edge = (p: Point[], i: number) => Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y)

describe('M3-03 furniture shape follows its family', () => {
  it('M3-03: a tilted near-square sketch is squared up and drawn at the family footprint', () => {
    const stroke = tiltedSquare({ x: 200, y: 330 }, 0.42 * PT_PER_M, 20)
    const ev = gatherEvidence(stroke, testContext())
    const s = shapeFor('furniture', ev, S, DEFAULT_PALETTE, {})
    expect(s.type).toBe('Chair 500x500')
    const p = s.geometry.points
    expect(Math.abs(p[1].y - p[0].y)).toBeLessThan(1e-6) // axis-aligned
    expect(edge(p, 0) / PT_PER_M).toBeCloseTo(0.5, 3)
    expect(edge(p, 1) / PT_PER_M).toBeCloseTo(0.5, 3)
  })

  it('M3-03: an elongated sketch at a deliberate angle keeps it', () => {
    const r = (deg: number) => (deg * Math.PI) / 180
    const c = { x: 150, y: 300 }
    const [w, h, a] = [1.6 * PT_PER_M, 0.8 * PT_PER_M, r(25)]
    const pts = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ].map(([u, v]) => ({ x: c.x + (w / 2) * u * Math.cos(a) - (h / 2) * v * Math.sin(a), y: c.y + (w / 2) * u * Math.sin(a) + (h / 2) * v * Math.cos(a) }))
    const s = shapeFor('furniture', gatherEvidence(polyStroke(pts), testContext()), S, DEFAULT_PALETTE, {})
    const p = s.geometry.points
    const ang = (Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x) * 180) / Math.PI
    expect(Math.abs(((ang % 90) + 90) % 90 - 25)).toBeLessThan(1)
  })

  it('M3-03: a sketch next to placed furniture of its size takes that type over a slightly nearer size match', () => {
    const palette: TypePalette = {
      ...DEFAULT_PALETTE,
      furniture: [
        { name: 'Dining Chair', widthMm: 440, depthMm: 345 },
        { name: 'Bar Chair', widthMm: 445, depthMm: 445 },
      ],
    }
    const stool = (x: number): SheetContext['items'][number] => {
      const s = 0.445 * PT_PER_M
      return {
        id: `stool-${x}`,
        kind: 'fixture',
        geometry: { points: [{ x, y: 330 }, { x: x + s, y: 330 }, { x: x + s, y: 330 + s }, { x, y: 330 + s }], closed: true },
        confidence: 1,
        props: { category: 'Furniture', typeName: 'Bar Chair' },
      }
    }
    const sketch = rectStroke(180, 330, 0.4 * PT_PER_M, 0.37 * PT_PER_M)
    const alone = shapeFor('furniture', gatherEvidence(sketch, testContext()), S, palette, {})
    expect(alone.type).toBe('Dining Chair')
    const ctx = testContext()
    ctx.items.push(stool(160), stool(225))
    const next = shapeFor('furniture', gatherEvidence(sketch, ctx), S, palette, {})
    expect(next.type).toBe('Bar Chair')
    expect(next.evidence.join(' ')).toMatch(/next to Bar Chair/)
  })
})
