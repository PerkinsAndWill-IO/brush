import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, SheetContext } from '../../../src/core/types'
import { DEFAULT_PALETTE, withDrawnWalls } from '../../../src/core/context'
import { PT_PER_M, polyStroke, replayStroke, settings } from '../predict/helpers'

const S = settings()
const empty = (): SheetContext => ({ sheetId: 'sheet-0', origin: 'inferred', scale: 100, items: [] })
const drawn = (strokeId: string, pts: { x: number; y: number }[], over: Partial<AcceptedDecision> = {}): AcceptedDecision => ({
  strokeId,
  sheetId: 'sheet-0',
  kind: 'wall',
  geometry: { points: pts, closed: false },
  confidence: 0.9,
  type: 'Generic - 200mm',
  committedAt: 0,
  ...over,
})
// a drawn 6 m wall along y = 100, plus a label so the sheet is not shape-only
const base = (): SheetContext => ({
  ...empty(),
  items: [{ id: 'lbl', kind: 'label', text: 'ROOM', geometry: { points: [{ x: 500, y: 500 }, { x: 520, y: 500 }, { x: 520, y: 506 }, { x: 500, y: 506 }], closed: true }, confidence: 0.9 }],
})
const myWall = drawn('s1', [{ x: 100, y: 100 }, { x: 100 + 6 * PT_PER_M, y: 100 }])

describe('M3-03 drawn walls are context', () => {
  it('M3-03: accepted walls on the sheet become wall items with thickness from their type and a host ref', () => {
    const ctx = withDrawnWalls(base(), [myWall, drawn('s2', [{ x: 0, y: 0 }, { x: 50, y: 0 }], { sheetId: 'other' }), drawn('s3', [{ x: 0, y: 0 }, { x: 9, y: 9 }], { kind: 'markup' })], {
      palette: DEFAULT_PALETTE,
      refs: new Map([['s1', 'cmd-7']]),
    })
    const walls = ctx.items.filter((i) => i.kind === 'wall')
    expect(walls).toHaveLength(1)
    expect(walls[0].hostRef).toBe('cmd-7')
    expect(Number(walls[0].props?.thicknessPt)).toBeCloseTo(0.2 * PT_PER_M, 2)
  })

  it('M3-03: with nothing drawn the context object is returned unchanged', () => {
    const c = base()
    expect(withDrawnWalls(c, [])).toBe(c)
  })

  it('M3-03: a new wall drawn near the end of my own wall snaps onto it', () => {
    const ctx = withDrawnWalls(base(), [myWall], { palette: DEFAULT_PALETTE })
    const end = { x: 100 + 6 * PT_PER_M, y: 100 }
    // starts 5 pt off the end of my wall, runs down ~3 deg off vertical
    const h = replayStroke(polyStroke([{ x: end.x + 4, y: end.y + 3 }, { x: end.x + 4 + 6, y: end.y + 3 + 4 * PT_PER_M }]), ctx, S).final
    expect(h.kind).toBe('wall')
    expect(h.geometry.points[0].x).toBeCloseTo(end.x, 6)
    expect(h.geometry.points[0].y).toBeCloseTo(end.y, 6)
    expect(h.geometry.points[1].x).toBeCloseTo(end.x, 6)
  })

  it('M3-03: a door tick across my own wall is placed on it', () => {
    const ctx = withDrawnWalls(base(), [myWall], { palette: DEFAULT_PALETTE })
    const h = replayStroke(polyStroke([{ x: 200, y: 100 - 0.45 * PT_PER_M }, { x: 201, y: 100 + 0.45 * PT_PER_M }]), ctx, S).final
    expect(h.kind).toBe('door')
    expect(h.targets).toEqual(['drawn-wall-s1'])
    for (const p of h.geometry.points) expect(p.y).toBeCloseTo(100, 6)
  })
})
