import { describe, expect, it } from 'vitest'
import type { Command, ContextItem, SheetContext } from '@core/types'
import { SpatialIndex } from '@core/geometry'
import { moveHost, pasteHost, slideAlongWall, snapDrag } from '../../src/app/select/moveHost'

const ids = (start: number) => {
  let n = start
  return () => `cmd-${String(n++).padStart(4, '0')}`
}
const wall = (id: string, x0: number, y0: number, x1: number, y1: number, hostRef?: string): ContextItem => ({
  id, kind: 'wall', geometry: { points: [{ x: x0, y: y0 }, { x: x1, y: y1 }], closed: false }, confidence: 1, ...(hostRef ? { hostRef } : {}),
})
const PT_PER_M = 28.35

describe('S2-04 moving host elements', () => {
  it('S2-04: two drags of one host element make one move with the summed offset', () => {
    const first = moveHost([], 'A', ['42'], { x: 10, y: 10 }, 30, 0, ids(1))
    expect(first).toHaveLength(1)
    const m1 = first[0].after.command as Extract<Command, { op: 'move' }>
    expect(m1).toMatchObject({ op: 'move', sheetId: 'A', targets: ['42'], at: { x: 10, y: 10 }, dx: 30, dy: 0, strokeId: 'move:42' })
    const second = moveHost([m1], 'A', ['42'], { x: 40, y: 10 }, 5, 7, ids(2))
    expect(second[0].before.command).toBe(m1)
    expect(second[0].after.command).toMatchObject({ dx: 35, dy: 7, at: { x: 10, y: 10 }, strokeId: 'move:42' })
  })

  it('S2-04: dragging back to the start drops the move', () => {
    const m1 = moveHost([], 'A', ['42'], { x: 10, y: 10 }, 30, 0, ids(1))[0].after.command!
    const back = moveHost([m1], 'A', ['42'], { x: 40, y: 10 }, -30, 0, ids(2))
    expect(back).toEqual([{ before: { command: m1 }, after: {} }])
  })

  it('S2-04: a door\'s offset is projected onto its wall', () => {
    expect(slideAlongWall(30, 40, { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false })).toEqual({ dx: 30, dy: 0 })
    expect(slideAlongWall(30, 40, null)).toEqual({ dx: 0, dy: 0 })
  })
})

describe('S2-04 pasting host elements', () => {
  const ctx: SheetContext = { sheetId: 'B', origin: 'package', items: [wall('wall-7', 0, 100, 300, 100, '7'), wall('cmd-0009', 0, 400, 300, 400)] }
  const clip = { sheetId: 'A', at: { x: 50, y: 50 }, elementIds: ['55'], categories: ['Doors'] }

  it('S2-04: a door pasted with no wall within 1 m is refused with a message', () => {
    const r = pasteHost(clip, 'B', { x: 150, y: 200 }, PT_PER_M, ctx, () => false, 3, ids(1))
    expect(r).toEqual({ refused: expect.stringMatching(/wall/i) })
  })

  it('S2-04: a door pasted near a wall Revit has makes one copy at the snapped point', () => {
    const r = pasteHost(clip, 'B', { x: 150, y: 110 }, PT_PER_M, ctx, () => false, 3, ids(1))
    expect(r).toEqual({ command: { op: 'copy', id: 'cmd-0001', sheetId: 'A', targets: ['55'], at: { x: 50, y: 50 }, toSheetId: 'B', to: { x: 150, y: 100 }, strokeId: 'copy:3' } })
  })

  it('S2-04: a drawn wall counts only once Revit applied it', () => {
    const near = { x: 150, y: 410 }
    expect(pasteHost(clip, 'B', near, PT_PER_M, ctx, () => false, 3, ids(1))).toHaveProperty('refused')
    expect(pasteHost(clip, 'B', near, PT_PER_M, ctx, (id) => id === 'cmd-0009', 3, ids(1))).toHaveProperty('command.to', { x: 150, y: 400 })
  })

  it('S2-04: a wall or furniture pastes where the cursor is, no wall needed', () => {
    const r = pasteHost({ ...clip, categories: ['Furniture'] }, 'B', { x: 150, y: 200 }, PT_PER_M, ctx, () => false, 4, ids(1))
    expect(r).toHaveProperty('command.to', { x: 150, y: 200 })
  })
})

describe('S2-04 snapping a drag', () => {
  const lines = new SpatialIndex([wall('w1', 200, 0, 200, 300), wall('w2', 0, 300, 400, 300)])
  it('S2-04: snapDrag moves a wall end onto a corner within the radius and not with free', () => {
    const ends = [{ x: 0, y: 297 }, { x: 150, y: 297 }]
    expect(snapDrag(ends, 47, 1, lines, 8, false)).toEqual({ dx: 50, dy: 3 }) // (150,297)+(47,1) = (197,298) → corner (200,300)
    expect(snapDrag(ends, 47, 1, lines, 8, true)).toEqual({ dx: 47, dy: 1 })
    expect(snapDrag(ends, 10, -50, lines, 8, false)).toEqual({ dx: 10, dy: -50 }) // nothing near
  })
})
