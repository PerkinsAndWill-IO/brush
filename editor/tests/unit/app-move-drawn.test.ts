import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, Command, SheetContext, Stroke } from '@core/types'
import { copyDrawn, moveDrawn, pasteDrawn, type DrawnState } from '../../src/app/select/moveDrawn'

const ctx = (sheetId: string): SheetContext => ({ sheetId, origin: 'inferred', items: [], scale: 100 })
const line = (id: string, x0: number, y0: number, x1: number, y1: number): Stroke => ({ id, sheetId: 'A', tool: 'brush', size: 2, points: [{ x: x0, y: y0, t: 0 }, { x: x1, y: y1, t: 8 }] })
const wallS = line('w', 0, 0, 100, 0)
const doorS = line('d', 40, -10, 40, 10)
const wallD: AcceptedDecision = { strokeId: 'w', sheetId: 'A', kind: 'wall', type: 'Generic - 200mm', geometry: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false }, confidence: 1, committedAt: 0 }
const doorD: AcceptedDecision = { strokeId: 'd', sheetId: 'A', kind: 'door', type: 'Single-Flush 0900x2100', geometry: { points: [{ x: 35, y: 0 }, { x: 45, y: 0 }], closed: false }, confidence: 1, committedAt: 0, targets: ['cmd-0001'] }
const wallC: Command = { op: 'create_wall', id: 'cmd-0001', sheetId: 'A', strokeId: 'w', path: wallD.geometry, wallType: 'Generic - 200mm' }
const doorC: Command = { op: 'place_door', id: 'cmd-0002', sheetId: 'A', strokeId: 'd', at: { x: 40, y: 0 }, widthPt: 10, angleRad: 0, hostWallRef: 'cmd-0001', familyType: 'Single-Flush 0900x2100' }
const state: DrawnState = { strokes: [wallS, doorS], accepted: [wallD, doorD], commands: [wallC, doorC] }
const ids = (start: number) => {
  let n = start
  return () => `cmd-${String(n++).padStart(4, '0')}`
}

describe('S2-03 moving and pasting drawn elements', () => {
  it('S2-03: a moved wall\'s ink, geometry and command move by (dx, dy); the command has a new id', () => {
    const r = moveDrawn({ ...state, strokes: [wallS], accepted: [wallD], commands: [wallC] }, ['w'], 30, 5, ids(10), ctx)
    expect(r).toHaveLength(1)
    expect(r[0].before).toEqual({ stroke: wallS, decision: wallD, command: wallC })
    expect(r[0].after.stroke?.points.map((p) => [p.x, p.y])).toEqual([[30, 5], [130, 5]])
    expect(r[0].after.decision?.geometry.points).toEqual([{ x: 30, y: 5 }, { x: 130, y: 5 }])
    const c = r[0].after.command as Extract<Command, { op: 'create_wall' }>
    expect(c.id).toBe('cmd-0010')
    expect(c.path.points).toEqual([{ x: 30, y: 5 }, { x: 130, y: 5 }])
  })

  it('S2-03: a drawn door on a moved drawn wall moves with it and its hostWallRef follows the wall\'s new command', () => {
    const r = moveDrawn(state, ['w'], 30, 0, ids(10), ctx)
    expect(r).toHaveLength(2)
    const door = r.find((x) => x.before.stroke === doorS)!
    expect(door.after.decision?.geometry.points).toEqual([{ x: 65, y: 0 }, { x: 75, y: 0 }])
    expect(door.after.decision?.targets).toEqual(['cmd-0010'])
    expect((door.after.command as Extract<Command, { op: 'place_door' }>).hostWallRef).toBe('cmd-0010')
  })

  it('S2-03: a paste lands the group\'s centre on the cursor with new stroke and command ids', () => {
    const clip = copyDrawn(state, ['w'], 28.35)
    let k = 0
    const r = pasteDrawn(clip, 'A', { x: 500, y: 300 }, 28.35, () => `p${++k}`, ids(20), ctx)
    expect(r).toHaveLength(1)
    expect(r[0].before).toEqual({})
    expect(r[0].after.stroke?.id).toBe('p1')
    expect(r[0].after.decision?.strokeId).toBe('p1')
    expect(r[0].after.decision?.geometry.points).toEqual([{ x: 450, y: 300 }, { x: 550, y: 300 }])
    expect(r[0].after.command?.id).toBe('cmd-0020')
    expect(r[0].after.command?.strokeId).toBe('p1')
  })

  it('S2-03: a paste on a sheet at 1:50 from 1:100 keeps real-world size (geometry ×2 about the centre)', () => {
    const clip = copyDrawn(state, ['w'], 28.35)
    const r = pasteDrawn(clip, 'B', { x: 500, y: 300 }, 56.7, () => 'p1', ids(20), ctx)
    expect(r[0].after.decision?.sheetId).toBe('B')
    expect(r[0].after.decision?.geometry.points).toEqual([{ x: 400, y: 300 }, { x: 600, y: 300 }])
    expect(r[0].after.stroke?.sheetId).toBe('B')
  })
})

describe('S2-03 pasting a wall with its door', () => {
  it('S2-03: a pasted door hosted in a pasted wall points at the pasted wall\'s command', () => {
    const clip = copyDrawn(state, ['w', 'd'], 28.35)
    let k = 0
    const r = pasteDrawn(clip, 'A', { x: 500, y: 300 }, 28.35, () => `p${++k}`, ids(20), ctx)
    const wall = r.find((x) => x.after.decision?.kind === 'wall')!
    const door = r.find((x) => x.after.decision?.kind === 'door')!
    expect(door.after.decision?.targets).toEqual([wall.after.command!.id])
    expect((door.after.command as Extract<Command, { op: 'place_door' }>).hostWallRef).toBe(wall.after.command!.id)
  })
})
