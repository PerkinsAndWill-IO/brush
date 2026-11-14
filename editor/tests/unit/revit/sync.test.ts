import { describe, expect, it } from 'vitest'
import type { Command, Stroke } from '../../../src/core/types'
import { CommandSync } from '../../../src/app/revit/sync'

const wall = (id: string, strokeId = `s-${id}`, sheetId = 'S1'): Command => ({
  op: 'create_wall',
  id,
  sheetId,
  strokeId,
  path: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false },
})
const stroke = (id: string, sheetId = 'S1'): Stroke => ({ id, sheetId, tool: 'brush', size: 2, points: [{ x: 0, y: 0, t: 0 }] })
const linked = new Set(['S1'])

describe('M6-03 / M6-04 / M6-06 CommandSync', () => {
  it('M6-03 plans new commands of linked sheets once, batched per sheet', () => {
    const sync = new CommandSync()
    const log = [wall('c1'), wall('c2'), wall('c3', 's3', 'OTHER')]
    const plan = sync.plan(log, linked)
    expect(plan.apply).toEqual([{ sheetId: 'S1', commands: [log[0], log[1]] }])
    expect(plan.revert).toEqual([])
    expect(sync.plan(log, linked).apply).toEqual([]) // in flight: not sent twice
    expect(sync.hasWork(log, linked)).toBe(false)
  })

  it('M6-04 hides a stroke once its command is applied and a new sheet version arrived', () => {
    const sync = new CommandSync()
    const log = [wall('c1', 's1')]
    sync.plan(log, linked)
    sync.onApplied([{ id: 'c1', status: 'applied', elementIds: ['900'] }])
    expect(sync.landedStrokes([stroke('s1')], log).size).toBe(0) // applied, sheet not back yet
    sync.onSheetVersion('S1')
    expect([...sync.landedStrokes([stroke('s1')], log)]).toEqual(['s1'])
  })

  it('M6-04 skipped counts as landed at once; failed stays visible and is not resent', () => {
    const sync = new CommandSync()
    const log = [wall('c1', 's1'), wall('c2', 's2')]
    sync.plan(log, linked)
    sync.onApplied([
      { id: 'c1', status: 'skipped', notes: ['already applied'] },
      { id: 'c2', status: 'failed', message: 'c2: not inside a plan viewport' },
    ])
    expect([...sync.landedStrokes([stroke('s1'), stroke('s2')], log)]).toEqual(['s1'])
    expect(sync.entry('c2')).toMatchObject({ status: 'failed', message: 'c2: not inside a plan viewport' })
    expect(sync.plan(log, linked).apply).toEqual([])
  })

  it('M6-06 a command that leaves the log after it was applied is reverted; redo applies it again', () => {
    const sync = new CommandSync()
    const c1 = wall('c1', 's1')
    sync.plan([c1], linked)
    sync.onApplied([{ id: 'c1', status: 'applied' }])
    sync.onSheetVersion('S1')
    // undo of the commit: c1 is gone from the log
    expect(sync.hasWork([], linked)).toBe(true)
    const plan = sync.plan([], linked)
    expect(plan.revert).toEqual([{ sheetId: 'S1', commandIds: ['c1'] }])
    expect(sync.entry('c1')?.status).toBe('reverting')
    expect(sync.landedStrokes([stroke('s1')], []).size).toBe(0) // no command left: the ink shows again
    sync.onReverted([{ id: 'c1', status: 'applied' }])
    expect(sync.entry('c1')).toBeUndefined()
    // redo: c1 back in the log → applied again
    expect(sync.plan([c1], linked).apply).toEqual([{ sheetId: 'S1', commands: [c1] }])
  })

  it('a command removed while in flight is reverted after its applied reply', () => {
    const sync = new CommandSync()
    sync.plan([wall('c1')], linked)
    expect(sync.plan([], linked).revert).toEqual([]) // still sending: wait
    sync.onApplied([{ id: 'c1', status: 'applied' }])
    expect(sync.plan([], linked).revert).toEqual([{ sheetId: 'S1', commandIds: ['c1'] }])
  })

  it('a failed command that leaves the log is just forgotten', () => {
    const sync = new CommandSync()
    sync.plan([wall('c1')], linked)
    sync.onApplied([{ id: 'c1', status: 'failed', message: 'x' }])
    expect(sync.plan([], linked)).toEqual({ apply: [], revert: [] })
    expect(sync.entry('c1')).toBeUndefined()
  })

  it('a drop forgets commands in flight (resent later) and retries reverts', () => {
    const sync = new CommandSync()
    const c1 = wall('c1')
    const c2 = wall('c2')
    sync.plan([c1, c2], linked)
    sync.onApplied([{ id: 'c2', status: 'applied' }])
    sync.plan([c1], linked) // c2 → reverting
    sync.onDisconnected()
    expect(sync.entry('c1')).toBeUndefined()
    expect(sync.entry('c2')?.status).toBe('applied')
    const plan = sync.plan([c1], linked)
    expect(plan.apply[0].commands).toEqual([c1])
    expect(plan.revert).toEqual([{ sheetId: 'S1', commandIds: ['c2'] }])
  })

  it('an error answer marks the batch failed with its message', () => {
    const sync = new CommandSync()
    sync.plan([wall('c1')], linked)
    sync.onRequestFailed(['c1'], 'host_error: boom')
    expect(sync.entry('c1')).toMatchObject({ status: 'failed', message: 'host_error: boom' })
  })

  it('strokes without commands (markup) are never hidden; a stroke with two commands needs both landed', () => {
    const sync = new CommandSync()
    const log = [wall('c1', 's1'), wall('c2', 's1')]
    sync.plan(log, linked)
    sync.onApplied([{ id: 'c1', status: 'applied' }])
    sync.onSheetVersion('S1')
    expect(sync.landedStrokes([stroke('s1'), stroke('markup')], log).size).toBe(0)
    sync.onApplied([{ id: 'c2', status: 'applied' }])
    sync.onSheetVersion('S1')
    expect([...sync.landedStrokes([stroke('s1'), stroke('markup')], log)]).toEqual(['s1'])
  })
})
