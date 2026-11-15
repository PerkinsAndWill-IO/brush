import { describe, expect, it } from 'vitest'
import type { Command } from '../../../src/core/types'
import { buildCommandFile, parseCommandFile, serializeCommandFile } from '../../../src/app/source/command-file'
import { restoredCommands } from '../../../src/app/session'

const move: Command = { op: 'move', id: 'cmd-0003', sheetId: 'A', targets: ['42'], at: { x: 100, y: 50 }, dx: 30, dy: 0, strokeId: 'move:42' }
const copy: Command = { op: 'copy', id: 'cmd-0004', sheetId: 'A', targets: ['42'], at: { x: 100, y: 50 }, toSheetId: 'B', to: { x: 300, y: 80 }, strokeId: 'copy:1' }
const wall: Command = { op: 'create_wall', id: 'cmd-0001', sheetId: 'A', strokeId: 's1', path: { points: [{ x: 0, y: 0 }, { x: 9, y: 0 }], closed: false } }

describe('S2-01 move and copy commands', () => {
  it('S2-01: move and copy round-trip through the command file', () => {
    const f = buildCommandFile({ source: { name: 'p.drawing', kind: 'package' }, sheets: [], commands: [move, copy] })
    expect(parseCommandFile(serializeCommandFile(f)).commands).toEqual([move, copy])
  })

  it('S2-01: a session reload keeps move and copy without strokes when their sheets are in the document', () => {
    expect(restoredCommands([wall, move, copy], new Set(['s1']), new Set(['A', 'B']))).toEqual([wall, move, copy])
    expect(restoredCommands([move, copy], new Set(), new Set(['A']))).toEqual([move]) // the copy's target sheet is gone
    expect(restoredCommands([wall, move], new Set(), new Set(['B']))).toEqual([])
  })
})
