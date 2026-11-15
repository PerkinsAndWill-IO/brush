/**
 * P1-07 (photo imports are groups) and P1-08 (make elements from an import), app/photo/groups.ts, interpret.ts and
 * the history step they use (docs/tasks/P1-photo-import.md).
 */
import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, Command, Stroke } from '../../src/core/types'
import { StrokeHistory } from '../../src/app/board/history'
import { photoGroupOf, photoGroups } from '../../src/app/photo/groups'
import { newWallsContext, numberCommands, readStrokes } from '../../src/app/photo/interpret'
import { markupToStrokes } from '../../src/app/photo/toStrokes'
import { PT_PER_M, polyStroke, scribbleStroke, settings, testContext } from './predict/helpers'

const ctx = testContext()
const S = settings()

/** Strokes the way an import makes them: traced polylines, resampled, with ids `<prefix><n>`. */
function imported(prefix: string, lines: [number, number][][], color: [number, number, number] = [208, 32, 44]): Stroke[] {
  return markupToStrokes([{ name: 'red', color, strokes: lines.map((points) => ({ points, width: 1.2, closed: false })) }], {
    sheetId: 'sheet-0',
    idPrefix: prefix,
    startedAt: 1_700_000_000_000,
  })
}

/** A 6 m wall along wall-v of the test context, and a 0.9 m door tick across wall-h (as in the predictor tests). */
const WALL: [number, number][] = [
  [301.5, 150],
  [301.5 + 6 * PT_PER_M, 152],
]
const DOOR: [number, number][] = [
  [450, 100 - 0.45 * PT_PER_M],
  [450.5, 100 + 0.45 * PT_PER_M],
]

describe('P1-07 photo-import groups', () => {
  it('P1-07: a stroke belongs to the import whose id prefix it carries; hand-drawn strokes belong to none', () => {
    expect(photoGroupOf('pmhx2k3a0-0')).toBe('pmhx2k3a0-')
    expect(photoGroupOf('pmhx2k3a0-117')).toBe('pmhx2k3a0-')
    expect(photoGroupOf('smhx2k3a0')).toBeUndefined()
    expect(photoGroupOf('pmhx2k3a0-')).toBeUndefined()
    expect(photoGroupOf('pmhx2k3a0-1+pmhx2k3a0-2')).toBeUndefined()
  })

  it('P1-07: groups list each import once, in order, with its strokes, sheet, colours and elements', () => {
    const a = imported('pa1-', [WALL, DOOR])
    const b = imported('pb2-', [WALL], [30, 80, 200])
    const hand = polyStroke([
      { x: 10, y: 10 },
      { x: 90, y: 10 },
    ])
    const accepted: AcceptedDecision[] = [{ strokeId: 'pa1-1', sheetId: 'sheet-0', kind: 'door', geometry: { points: [], closed: false }, confidence: 0.9, committedAt: 0 }]
    const groups = photoGroups([...a, { ...hand, id: 'sx1' }, ...b], accepted)
    expect(groups.map((g) => g.id)).toEqual(['pa1-', 'pb2-'])
    expect(groups[0].strokeIds).toEqual(['pa1-0', 'pa1-1'])
    expect(groups[0].elements).toBe(1)
    expect(groups[0].sheetId).toBe('sheet-0')
    expect(groups[0].colors).toEqual(['#d0202c'])
    expect(groups[1].colors).toEqual(['#1e50c8'])
    expect(groups[1].elements).toBe(0)
  })

  it('P1-07: removing a group is one undo step, and its elements and commands go and come back with it', () => {
    const strokes = imported('pa1-', [WALL, DOOR])
    const decision: AcceptedDecision = { strokeId: 'pa1-0', sheetId: 'sheet-0', kind: 'wall', geometry: { points: [], closed: false }, confidence: 0.9, committedAt: 0 }
    const command = { id: 'cmd-0001', strokeId: 'pa1-0' } as unknown as Command
    const h = new StrokeHistory([{ ...polyStroke([{ x: 0, y: 0 }, { x: 50, y: 0 }]), id: 'sx1' }, ...strokes], [decision], [command])
    h.erase(new Set(strokes.map((s) => s.id)))
    expect(h.strokes().map((s) => s.id)).toEqual(['sx1'])
    expect(h.accepted()).toEqual([])
    expect(h.commands()).toEqual([])
    h.undo()
    expect(h.strokes().map((s) => s.id)).toEqual(['sx1', 'pa1-0', 'pa1-1'])
    expect(h.accepted()).toEqual([decision])
    expect(h.commands()).toEqual([command])
  })
})

describe('P1-08 make elements from an import', () => {
  it('P1-08: imported strokes read like drawn ones: a wall stroke becomes a wall, a door tick a door', () => {
    let n = 1
    const r = readStrokes(imported('pa1-', [WALL, DOOR]), ctx, S, { nextCommandId: () => `cmd-${String(n++).padStart(4, '0')}`, committedAt: 42 })
    expect(r.outcomes.get('pa1-0')).toBe('element')
    expect(r.outcomes.get('pa1-1')).toBe('element')
    expect(r.decisions.map((d) => d.decision.kind)).toEqual(['wall', 'door'])
    expect(r.byKind).toEqual({ wall: 1, door: 1 })
    for (const { decision, command } of r.decisions) {
      expect(decision.committedAt).toBe(42)
      expect(command?.strokeId).toBe(decision.strokeId)
    }
    expect(new Set(r.decisions.map((d) => d.command?.id)).size).toBe(2)
  })

  it('P1-08: a reading the brush is not sure of, or markup, stays ink: nothing is committed for it', () => {
    const scribble = { ...scribbleStroke(700, 600, 30, 30), id: 'pa1-9' }
    const r = readStrokes([scribble], { ...ctx, items: [], shapeOnly: true }, S, { nextCommandId: () => 'cmd-x', committedAt: 0 })
    const outcome = r.outcomes.get('pa1-9')
    if (outcome === 'element') {
      // a scribble may read as delete over nothing; whatever it is, it must have been a confident reading
      expect(r.decisions).toHaveLength(1)
      expect(r.decisions[0].decision.confidence).toBeGreaterThanOrEqual(S.chipHigh)
    } else {
      expect(r.decisions).toHaveLength(0)
    }
  })

  it('P1-08: command ids are given at commit, after every command the session has by then', () => {
    const r = readStrokes(imported('pa1-', [WALL, DOOR]), ctx, S, { committedAt: 1 })
    // meanwhile the live brush committed cmd-0007 (and earlier ones)
    const session = [{ id: 'cmd-0003' }, { id: 'cmd-0007' }] as unknown as Command[]
    const numbered = numberCommands([...r.decisions, { decision: r.decisions[0].decision, command: null }], session, 'cmd')
    expect(numbered.map((d) => d.command?.id ?? null)).toEqual(['cmd-0008', 'cmd-0009', null])
    expect(numbered[0].decision).toBe(r.decisions[0].decision)
    expect(r.decisions[0].command?.id).toBe('pending') // the input is not changed
  })

  it('P1-08: elements made together are one undo step', () => {
    const h = new StrokeHistory(imported('pa1-', [WALL, DOOR]))
    let n = 1
    const r = readStrokes(h.strokes(), ctx, S, { nextCommandId: () => `cmd-${String(n++).padStart(4, '0')}`, committedAt: 1 })
    h.commitMany(r.decisions)
    expect(h.accepted()).toHaveLength(2)
    expect(h.commands().length).toBe(r.decisions.filter((d) => d.command).length)
    h.undo()
    expect(h.accepted()).toHaveLength(0)
    expect(h.commands()).toHaveLength(0)
    expect(h.strokes()).toHaveLength(2)
    h.redo()
    expect(h.accepted()).toHaveLength(2)
  })

  it('C1-05: a photo with a new wall and a door in it: the door is hosted in the new wall, whatever the stroke order', () => {
    // a 10 m wall inside the room (no wall there on the sheet) and a 0.9 m tick across it, the door traced first
    const NEW_WALL: [number, number][] = [
      [150, 100],
      [150.5, 395],
    ]
    const TICK: [number, number][] = [
      [150 - 0.45 * PT_PER_M, 250],
      [150 + 0.45 * PT_PER_M, 250.5],
    ]
    const strokes = imported('pc1-', [TICK, NEW_WALL])
    // pass 1 (what groupActions.makeElements reads first): the door has no wall to sit in
    const first = readStrokes(strokes, ctx, S, { committedAt: 1 })
    expect(first.decisions.map((d) => d.decision.kind)).toEqual(['wall'])
    const walls = newWallsContext(first.decisions, ctx)!
    const wallIds = new Set(walls.walls.map((w) => w.decision.strokeId))
    // pass 2: everything else, against the sheet plus the new wall
    const second = readStrokes(strokes.filter((s) => !wallIds.has(s.id)), walls.ctx, S, { committedAt: 1, history: walls.walls.map((w) => w.decision) })
    expect(second.decisions.map((d) => d.decision.kind)).toEqual(['door'])
    const numbered = numberCommands([...walls.walls, ...second.decisions], [{ id: 'cmd-0004' }] as unknown as Command[], 'cmd')
    expect(numbered.map((d) => d.command?.op)).toEqual(['create_wall', 'place_door']) // the wall is applied first
    const door = numbered[1].command!
    expect(door.op === 'place_door' && door.hostWallRef).toBe('cmd-0005')
  })

  it('C1-05: a door whose new host wall did not make it into the batch names no host (the model picks the nearest)', () => {
    const decision = { strokeId: 'd' } as AcceptedDecision
    const door: Command = { op: 'place_door', id: 'pending', sheetId: 'sheet-0', strokeId: 'd', at: { x: 0, y: 0 }, widthPt: 25, angleRad: 0, hostWallRef: 'new-wall:gone' }
    const [out] = numberCommands([{ decision, command: door }], [], 'cmd')
    expect(out.command?.op === 'place_door' && out.command.hostWallRef).toBeUndefined()
  })
})
