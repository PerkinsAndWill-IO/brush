import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, SheetContext } from '../../../src/core/types'
import { COMMAND_OPS, CommandLog, OP_FOR_KIND, commandFromDecision } from '../../../src/core/commands'

const dec = (over: Partial<AcceptedDecision>): AcceptedDecision => ({
  strokeId: 's1',
  sheetId: 'sheet-0',
  kind: 'markup',
  geometry: { points: [], closed: false },
  confidence: 0.9,
  committedAt: 1000,
  ...over,
})

const pkgCtx: SheetContext = {
  sheetId: 'sheet-0',
  origin: 'package',
  items: [{ id: 'wall-1', kind: 'wall', geometry: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false }, confidence: 1, hostRef: 'W-123' }],
}

describe('M5 command vocabulary', () => {
  it('maps every decision kind to its op (markup emits none)', () => {
    expect(OP_FOR_KIND).toEqual({ wall: 'create_wall', door: 'place_door', furniture: 'place_instance', delete: 'delete', markup: null })
    expect(COMMAND_OPS).toHaveLength(4)
  })

  it('wall -> create_wall with path and wallType', () => {
    const c = commandFromDecision(
      dec({ kind: 'wall', type: 'Generic - 200mm', geometry: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], closed: false } }),
      'cmd-0001',
    )
    expect(c).toEqual({
      op: 'create_wall',
      id: 'cmd-0001',
      sheetId: 'sheet-0',
      path: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], closed: false },
      wallType: 'Generic - 200mm',
      strokeId: 's1',
    })
  })

  it('door -> place_door at the opening middle, with width, angle, host wall (hostRef in packages) and family', () => {
    const c = commandFromDecision(
      dec({ kind: 'door', type: 'Single-Flush 0900x2100', targets: ['wall-1'], geometry: { points: [{ x: 10, y: 0 }, { x: 10, y: 25.5 }], closed: false } }),
      'cmd-0002',
      pkgCtx,
    )
    expect(c?.op).toBe('place_door')
    if (c?.op !== 'place_door') return
    expect(c.at).toEqual({ x: 10, y: 12.75 })
    expect(c.widthPt).toBeCloseTo(25.5)
    expect(c.angleRad).toBeCloseTo(Math.PI / 2)
    expect(c.hostWallRef).toBe('W-123')
    expect(c.familyType).toBe('Single-Flush 0900x2100')
    // plain PDF: the context item id is the host reference
    const plain = commandFromDecision(dec({ kind: 'door', targets: ['wall-9'], geometry: { points: [{ x: 0, y: 0 }, { x: 25, y: 0 }], closed: false } }), 'x')
    expect(plain?.op === 'place_door' && plain.hostWallRef).toBe('wall-9')
  })

  it('furniture -> place_instance with centre, unrotated bbox, angle and family', () => {
    const c = Math.cos(Math.PI / 6)
    const s = Math.sin(Math.PI / 6)
    const corner = (u: number, v: number) => ({ x: 200 + u * c - v * s, y: 100 + u * s + v * c })
    const cmd = commandFromDecision(
      dec({ kind: 'furniture', type: 'Desk 1600x800', geometry: { points: [corner(-20, -10), corner(20, -10), corner(20, 10), corner(-20, 10)], closed: true } }),
      'cmd-0003',
    )
    expect(cmd?.op).toBe('place_instance')
    if (cmd?.op !== 'place_instance') return
    expect(cmd.at.x).toBeCloseTo(200)
    expect(cmd.at.y).toBeCloseTo(100)
    expect(cmd.bbox.w).toBeCloseTo(40)
    expect(cmd.bbox.h).toBeCloseTo(20)
    expect(cmd.bbox.x).toBeCloseTo(180)
    expect(cmd.angleRad).toBeCloseTo(Math.PI / 6)
    expect(cmd.family).toBe('Desk 1600x800')
  })

  it('delete -> delete with targets; no targets or markup -> no command', () => {
    const d = commandFromDecision(dec({ kind: 'delete', targets: ['wall-1', 'fixture-2'] }), 'cmd-0004', pkgCtx)
    expect(d).toEqual({ op: 'delete', id: 'cmd-0004', sheetId: 'sheet-0', targets: ['W-123', 'fixture-2'], strokeId: 's1' })
    expect(commandFromDecision(dec({ kind: 'delete' }), 'x')).toBeNull()
    expect(commandFromDecision(dec({ kind: 'markup', geometry: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false } }), 'x')).toBeNull()
  })
})

describe('M5 command log', () => {
  const wall = dec({ kind: 'wall', strokeId: 'a', geometry: { points: [{ x: 0, y: 0 }, { x: 50, y: 0 }], closed: false } })
  const door = dec({ kind: 'door', strokeId: 'b', targets: ['wall-1'], geometry: { points: [{ x: 10, y: 0 }, { x: 35, y: 0 }], closed: false } })

  it('appends with deterministic sequential ids and skips markup', () => {
    const log = new CommandLog()
    expect(log.append(wall)?.id).toBe('cmd-0001')
    expect(log.append(dec({ kind: 'markup' }))).toBeNull()
    expect(log.append(door)?.id).toBe('cmd-0002')
    expect(log.length).toBe(2)
    expect(log.forStroke('b').map((c) => c.op)).toEqual(['place_door'])
  })

  it('same decisions -> same JSON; round-trips through toJSON / fromJSON and continues numbering', () => {
    const a = new CommandLog()
    const b = new CommandLog()
    for (const d of [wall, door]) {
      a.append(d)
      b.append(d)
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const json = JSON.parse(JSON.stringify(a))
    const restored = CommandLog.fromJSON(json)
    expect(restored.toJSON()).toEqual(a.toJSON())
    expect(restored.append(wall)?.id).toBe('cmd-0003')
    expect(() => restored.add(json[0])).toThrow(/duplicate/)
  })

  it('toJSON returns copies, not live references', () => {
    const log = new CommandLog()
    log.append(wall)
    const out = log.toJSON()
    if (out[0].op === 'create_wall') out[0].path.points[0].x = 999
    expect(log.toJSON()[0]).toEqual(commandFromDecision(wall, 'cmd-0001'))
  })
})
