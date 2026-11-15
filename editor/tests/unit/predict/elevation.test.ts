import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, Point, SheetContext } from '../../../src/core/types'
import { prepareContext, viewModeOf } from '../../../src/core/predict'
import { commandFromDecision } from '../../../src/core/commands'
import { PT_PER_M, ROOT, polyStroke, rectStroke, replayStroke, settings, testContext } from './helpers'

const auto = settings()

/** A sheet typed `sheetType` by its sheet-info item, with one grid line and a level label, at 1:100. */
function typedContext(sheetType: string): SheetContext {
  return {
    sheetId: 'sheet-0',
    origin: 'inferred',
    scale: 100,
    items: [
      { id: 'grid-1', kind: 'grid', geometry: { points: [{ x: 50, y: 20 }, { x: 50, y: 500 }], closed: false }, confidence: 0.9, text: '1' },
      {
        id: 'label-l1',
        kind: 'label',
        text: 'LEVEL 1 +0.000',
        geometry: { points: [{ x: 600, y: 400 }, { x: 660, y: 400 }, { x: 660, y: 407 }, { x: 600, y: 407 }], closed: true },
        confidence: 0.9,
      },
      {
        id: 'sheet-info',
        kind: 'unknown',
        geometry: { points: [{ x: 999, y: 999 }, { x: 1000, y: 999 }, { x: 1000, y: 1000 }, { x: 999, y: 1000 }], closed: true },
        confidence: 0.75,
        props: { role: 'sheet-info', sheetType, sheetTypeBy: 'title' },
      },
    ],
  }
}

const elevation = typedContext('elevation')
const m = (x: number) => x * PT_PER_M

/** Upright rectangle `w` x `h` m standing on y = `floor`, hand-drawn (slightly off square). */
const doorRect = (x: number, floor: number, w: number, h: number) => rectStroke(x, floor - m(h), m(w), m(h))
/** Inverted U: up the left jamb, across the head, down the right jamb. */
const doorU = (x: number, floor: number, w: number, h: number) =>
  polyStroke([{ x, y: floor }, { x: x + 1, y: floor - m(h) }, { x: x + m(w), y: floor - m(h) + 1 }, { x: x + m(w) - 1, y: floor }])

const widthM = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y) / PT_PER_M

describe('E1 the brush reads the sheet type and predicts openings on elevations', () => {
  it('E1-01: elevation and section sheets switch the brush to elevation reading; plans and unknown sheets do not', () => {
    expect(prepareContext(typedContext('elevation')).view).toBe('elevation')
    expect(prepareContext(typedContext('section')).view).toBe('elevation')
    expect(prepareContext(typedContext('plan')).view).toBe('plan')
    expect(prepareContext(typedContext('unknown')).view).toBe('plan')
    expect(prepareContext(testContext()).view).toBe('plan') // no sheet-info item
    expect(viewModeOf('detail')).toBe('detail')
    expect(viewModeOf('axonometric')).toBe('detail')
  })

  it('E1-01: the real KRO elevation sheet (typed by its drawing code -ELE-) reads as elevation', () => {
    const ctx = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'contexts', 'kro-project-3-sheets.pdf.1.json'), 'utf8')) as SheetContext
    expect(prepareContext(ctx).sheetType).toBe('elevation')
    const h = replayStroke(doorRect(300, 600, 0.9, 2.1), ctx, auto).final
    expect(h.kind).toBe('door')
  })

  it('E1-02: an upright 0.9 x 2.1 m rectangle on an elevation is a door (on a plan it is not)', () => {
    const s = doorRect(200, 400, 0.92, 2.05)
    const h = replayStroke(s, elevation, auto).final
    expect(h.kind).toBe('door')
    expect(h.confidence).toBeGreaterThan(0.6)
    expect(h.evidence?.some((e) => e.startsWith('elevation sheet'))).toBe(true)
    expect(replayStroke(s, typedContext('plan'), auto).final.kind).not.toBe('door')
  })

  it('E1-02: a door drawn as an inverted U (open at the floor) is a door', () => {
    const h = replayStroke(doorU(200, 400, 1.0, 2.1), elevation, auto).final
    expect(h.kind).toBe('door')
  })

  it('E1-02: a double door 1.8 x 2.1 m is a door of the double family', () => {
    const h = replayStroke(doorRect(200, 400, 1.75, 2.15), elevation, auto).final
    expect(h.kind).toBe('door')
    expect(h.type).toBe('Double-Flush 1800x2100')
  })

  it('E1-03: plan readings are off on elevations: a long line is not a wall, a box is not furniture', () => {
    const line = replayStroke(polyStroke([{ x: 100, y: 300 }, { x: 100 + m(4), y: 301 }]), elevation, auto).final
    expect(line.kind).toBe('markup')
    expect(line.alternatives.find((a) => a.kind === 'wall')).toBeUndefined()
    // a 1.2 x 1.2 m window-like square: not a door (too squat), not furniture
    const sq = replayStroke(doorRect(200, 300, 1.2, 1.2), elevation, auto).final
    expect(sq.kind).toBe('markup')
    expect(sq.alternatives.find((a) => a.kind === 'furniture')).toBeUndefined()
  })

  it('E1-04: the door is drawn face on at the family size, centred on the sketch and standing on its bottom edge', () => {
    const floor = 400
    const s = doorRect(200, floor, 0.93, 2.0)
    const h = replayStroke(s, elevation, auto).final
    expect(h.kind).toBe('door')
    expect(h.type).toBe('Single-Flush 0900x2100')
    expect(h.geometry.closed).toBe(true)
    const [bl, br, tr, tl] = h.geometry.points
    expect(h.geometry.points).toHaveLength(4)
    expect(bl.y).toBeCloseTo(floor, 0)
    expect(br.y).toBeCloseTo(floor, 0)
    expect(widthM(bl, br)).toBeCloseTo(0.9, 2)
    expect(widthM(bl, tl)).toBeCloseTo(2.1, 2)
    expect(widthM(br, tr)).toBeCloseTo(2.1, 2)
    expect((bl.x + br.x) / 2).toBeCloseTo(200 + m(0.93) / 2, 0)
    expect(h.targets).toBeUndefined() // no plan wall to host it
  })

  it('E1-04: Door mode on an elevation also draws the door face on', () => {
    const h = replayStroke(doorRect(200, 400, 0.8, 1.9), elevation, settings({ mode: 'door' })).final
    expect(h.kind).toBe('door')
    expect(h.geometry.closed).toBe(true)
    expect(h.type).toBe('Single-Flush 0800x2100')
  })

  it('E1-05: place_door from an elevation door takes its width and position from the bottom edge', () => {
    const h = replayStroke(doorRect(200, 400, 0.9, 2.1), elevation, auto).final
    const d: AcceptedDecision = { strokeId: 's', sheetId: 'sheet-0', kind: 'door', geometry: h.geometry, confidence: h.confidence, committedAt: 0, type: h.type }
    const c = commandFromDecision(d, 'cmd-0001', elevation)
    expect(c?.op).toBe('place_door')
    if (c?.op !== 'place_door') return
    expect(c.widthPt / PT_PER_M).toBeCloseTo(0.9, 2)
    expect(c.at.y).toBeCloseTo(400, 0)
    expect(c.angleRad).toBeCloseTo(0, 6)
  })
})

describe('E1 detail sheets: no plan readings on a detail', () => {
  const detail = typedContext('detail')

  it('E1-06: on a detail sheet a long straight stroke (a coping, a layer line) stays ink, not a wall', () => {
    const s = polyStroke([{ x: 100, y: 300 }, { x: 100 + m(4), y: 301 }])
    expect(replayStroke(s, typedContext('plan'), auto).final.kind).toBe('wall')
    const h = replayStroke(s, detail, auto).final
    expect(h.kind).toBe('markup')
    expect(h.alternatives).toEqual([])
    expect(h.evidence?.some((e) => e.startsWith('detail sheet'))).toBe(true)
  })

  it('E1-06: an L-shaped flashing profile and a closed box on a detail stay ink; the eraser still erases', () => {
    const flashing = polyStroke([{ x: 100, y: 300 }, { x: 100, y: 280 }, { x: 100 + m(2.5), y: 280 }, { x: 100 + m(2.5), y: 300 }])
    expect(replayStroke(flashing, detail, auto).final.kind).toBe('markup')
    expect(replayStroke(doorRect(200, 400, 0.9, 2.1), detail, auto).final.kind).toBe('markup')
    expect(replayStroke(rectStroke(200, 200, m(1.2), m(0.8)), detail, auto).final.kind).toBe('markup')
    const erase = polyStroke([{ x: 100, y: 100 }, { x: 160, y: 120 }], { tool: 'eraser' })
    expect(replayStroke(erase, detail, auto).final.kind).toBe('delete')
  })

  it('E1-06: an explicit mode still wins on a detail sheet', () => {
    const s = polyStroke([{ x: 100, y: 300 }, { x: 100 + m(4), y: 301 }])
    expect(replayStroke(s, detail, settings({ mode: 'wall' })).final.kind).toBe('wall')
  })
})
