import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, Command, Stroke } from '@core/types'
import { StrokeHistory, nextCommandId } from '../../src/app/board/history'

const stroke: Stroke = { id: 's1', sheetId: 'A', tool: 'brush', size: 2, points: [{ x: 0, y: 0, t: 0 }] }
const decision: AcceptedDecision = { strokeId: 's1', sheetId: 'A', kind: 'wall', geometry: { points: [{ x: 0, y: 0 }, { x: 9, y: 0 }], closed: false }, confidence: 1, committedAt: 0 }
const wall: Command = { op: 'create_wall', id: 'cmd-0007', sheetId: 'A', strokeId: 's1', path: decision.geometry }

describe('command ids are never reused', () => {
  it('after undo the next id is still new (an undone command may be waiting for its revert in Revit)', () => {
    const h = new StrokeHistory()
    h.add(stroke)
    h.commit(decision, wall)
    h.undo()
    expect(h.commands()).toEqual([])
    expect(nextCommandId(h.commands(), 'cmd', h.highestCommandNumber())).toBe('cmd-0008')
  })
})
