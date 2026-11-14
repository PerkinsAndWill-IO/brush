/**
 * C1 compound edits: walls sketched earlier in the session are context for the next stroke, so a door drawn on a
 * new wall is hosted in it (place_door.hostWallRef = the wall's command id).
 */
import { describe, expect, it } from 'vitest'
import type { Command } from '../../../src/core/types'
import { isSessionItem, withSessionElements } from '../../../src/core/context'
import { commandFromDecision } from '../../../src/core/commands'
import { StrokeSession } from '../../../src/core/predict'
import { PT_PER_M, polyStroke, settings, testContext } from '../predict/helpers'

const S = settings()

/** Read a stroke to the end and commit it, like the live brush after its pause. */
function commit(stroke: ReturnType<typeof polyStroke>, ctx: ReturnType<typeof testContext>) {
  const s = new StrokeSession({ ...stroke, points: [] }, ctx, S)
  for (const p of stroke.points) s.addPoint(p)
  s.end()
  return s.commit(1)
}

// A new 10 m wall inside the room, down from wall-h, then a 0.9 m door tick across it.
const newWall = () => polyStroke([{ x: 150, y: 100 }, { x: 150.5, y: 395 }], { id: 'w' })
const doorTick = () => polyStroke([{ x: 150 - 0.45 * PT_PER_M, y: 250 }, { x: 150 + 0.45 * PT_PER_M, y: 250.5 }], { id: 'd' })

describe('C1: session elements as context', () => {
  it('C1-01: a door drawn on a wall sketched in this session is hosted in that wall', () => {
    const base = testContext()
    const wall = commit(newWall(), base)
    expect(wall.kind).toBe('wall')
    const wallCmd = commandFromDecision(wall, 'cmd-0001', base)!

    // the sheet alone has no wall there: the tick is not read as a door hosted anywhere
    const alone = commit(doorTick(), base)
    expect(alone.kind === 'door' && alone.targets?.length).toBeFalsy()

    const ctx = withSessionElements(base, [wallCmd])
    const door = commit(doorTick(), ctx)
    expect(door.kind).toBe('door')
    expect(door.targets).toEqual(['cmd-0001'])
    const cmd = commandFromDecision(door, 'cmd-0002', ctx)!
    expect(cmd.op).toBe('place_door')
    expect(cmd.op === 'place_door' && cmd.hostWallRef).toBe('cmd-0001')
    // the opening sits on the new wall's line
    expect(cmd.op === 'place_door' && Math.abs(cmd.at.x - 150)).toBeLessThan(2)
  })

  it('C1-02: session walls get their type thickness, closed outlines their closing side', () => {
    const base = testContext()
    const cmds: Command[] = [
      { op: 'create_wall', id: 'cmd-0001', sheetId: 'sheet-0', strokeId: 's1', wallType: 'Exterior - 300mm', path: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false } },
      { op: 'create_wall', id: 'cmd-0002', sheetId: 'sheet-0', strokeId: 's2', path: { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], closed: true } },
      { op: 'create_wall', id: 'cmd-0003', sheetId: 'other', strokeId: 's3', path: { points: [{ x: 0, y: 0 }, { x: 9, y: 0 }], closed: false } },
    ]
    const ctx = withSessionElements(base, cmds)
    const mine = ctx.items.filter(isSessionItem)
    expect(mine.map((i) => i.id)).toEqual(['cmd-0001', 'cmd-0002'])
    expect(Number(mine[0].props!.thicknessPt)).toBeCloseTo(0.3 * PT_PER_M, 1)
    expect(mine[1].geometry.points).toHaveLength(4)
    expect(base.items.every((i) => !isSessionItem(i))).toBe(true) // the sheet's context is not changed
  })

  it('C1-03: deleted items and deleted session walls drop out; strokes already in the sheet are skipped', () => {
    const base = testContext()
    const wall: Command = { op: 'create_wall', id: 'cmd-0001', sheetId: 'sheet-0', strokeId: 's1', path: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false } }
    const del: Command = { op: 'delete', id: 'cmd-0002', sheetId: 'sheet-0', strokeId: 's2', targets: ['cmd-0001', 'wall-h'] }
    const ids = withSessionElements(base, [wall, del]).items.map((i) => i.id)
    expect(ids).not.toContain('cmd-0001')
    expect(ids).not.toContain('wall-h')
    expect(ids).toContain('wall-v')
    expect(withSessionElements(base, [wall], { skipStrokes: new Set(['s1']) })).toBe(base)
  })

  it('C1-04: the same context and log give the same object (the brush prepares it once)', () => {
    const base = testContext()
    const log: Command[] = [{ op: 'create_wall', id: 'cmd-0001', sheetId: 'sheet-0', strokeId: 's1', path: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false } }]
    expect(withSessionElements(base, log)).toBe(withSessionElements(base, log))
    expect(withSessionElements(base, [])).toBe(base)
  })
})
