import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, Command, Stroke } from '@core/types'
import { StrokeHistory } from '../../src/app/board/history'

const stroke = (id: string, x: number): Stroke => ({ id, sheetId: 'A', tool: 'brush', size: 2, points: [{ x, y: 0, t: 0 }, { x: x + 50, y: 0, t: 8 }] })
const decision = (s: Stroke): AcceptedDecision => ({ strokeId: s.id, sheetId: 'A', kind: 'wall', geometry: { points: s.points.map((p) => ({ x: p.x, y: p.y })), closed: false }, confidence: 1, committedAt: 0 })
const command = (s: Stroke, id: string): Command => ({ op: 'create_wall', id, sheetId: 'A', strokeId: s.id, path: decision(s).geometry })

describe('S2-02 replacements carry ink', () => {
  it('S2-02: a replacement moves a stroke\'s ink with its decision and command in one undo step', () => {
    const h = new StrokeHistory()
    const other = stroke('s0', 500)
    const s = stroke('s1', 0)
    h.add(other)
    h.add(s)
    h.commit(decision(s), command(s, 'cmd-0001'))
    const moved = stroke('s1', 30)
    h.replace([{ before: { stroke: s, decision: h.accepted()[0], command: h.commands()[0] }, after: { stroke: moved, decision: decision(moved), command: command(moved, 'cmd-0002') } }])
    expect(h.strokes().map((x) => [x.id, x.points[0].x])).toEqual([['s0', 500], ['s1', 30]])
    expect(h.accepted()[0].geometry.points[0].x).toBe(30)
    expect(h.commands().map((c) => c.id)).toEqual(['cmd-0002'])
    h.undo()
    expect(h.strokes()).toEqual([other, s])
    expect(h.accepted()[0].geometry.points[0].x).toBe(0)
    expect(h.commands().map((c) => c.id)).toEqual(['cmd-0001'])
  })

  it('S2-02: a replacement can add a new stroke with its decision and command (a paste); undo removes all three', () => {
    const h = new StrokeHistory()
    const s = stroke('s1', 0)
    h.add(s)
    const pasted = stroke('p1', 200)
    h.replace([{ before: {}, after: { stroke: pasted, decision: decision(pasted), command: command(pasted, 'cmd-0002') } }])
    expect(h.strokes().map((x) => x.id)).toEqual(['s1', 'p1'])
    expect(h.accepted().map((d) => d.strokeId)).toEqual(['p1'])
    h.undo()
    expect(h.strokes().map((x) => x.id)).toEqual(['s1'])
    expect(h.accepted()).toEqual([])
    expect(h.commands()).toEqual([])
    h.redo()
    expect(h.strokes().map((x) => x.id)).toEqual(['s1', 'p1'])
  })
})
