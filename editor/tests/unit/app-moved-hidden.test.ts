import { describe, expect, it } from 'vitest'
import type { Command } from '@core/types'
import { movedHostElements } from '../../src/app/select/moved'

const move = (id: string, el: string): Command => ({ op: 'move', id, sheetId: 'A', targets: [el], at: { x: 0, y: 0 }, dx: 10, dy: 0, strokeId: `move:${el}` })

describe('S2-07 moved elements leave their old place', () => {
  it('S2-07: elements with a move Revit has not redrawn are hidden at their old place; landed ones are not', () => {
    const cmds: Command[] = [move('cmd-1', '42'), move('cmd-2', '43'), { op: 'delete', id: 'cmd-3', sheetId: 'A', targets: ['44'], strokeId: 's' }]
    expect([...movedHostElements(cmds, (id) => id === 'cmd-2')]).toEqual(['42'])
    expect([...movedHostElements([], () => false)]).toEqual([])
  })
})
