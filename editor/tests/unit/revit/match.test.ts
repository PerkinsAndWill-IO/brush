import { describe, expect, it } from 'vitest'
import { matchFile, nameKey } from '../../../src/app/revit/match'

const tower = { title: 'Tower A', path: 'C:\\Projects\\Tower A.rvt', project: 'Project Name' }
const sheets = [
  { id: '382617', number: 'A102', name: 'Plans' },
  { id: '382700', number: 'A103', name: 'Level 3' },
]

describe('M6-11 matchFile: is the opened file the model open in Revit?', () => {
  it('M6-11 normalizes names: path, extensions, case, download suffix, punctuation', () => {
    expect(nameKey('C:\\Models\\Tower A (1).drawing')).toBe('towera')
    expect(nameKey('tower_a.rvt.drawing')).toBe('towera')
    expect(nameKey('/x/Tower-A.json.drawing')).toBe('towera')
    expect(nameKey(undefined)).toBe('')
  })

  it('M6-11 matches by file name and picks the file sheets Revit has, in file order', () => {
    const m = matchFile({ fileName: 'Tower A.drawing', sheets: [{ id: '382700', number: 'A103' }, { id: '960621' }, { id: '382617', number: 'A102' }] }, tower, sheets)
    expect(m).toEqual({ matches: true, by: 'name', sheetIds: ['382700', '382617'] })
  })

  it('M6-11 matches by the model a .drawing was exported from (source.file)', () => {
    expect(matchFile({ fileName: 'export-2026-11-15.drawing', model: 'Tower A', sheets: [] }, tower, sheets).by).toBe('name')
  })

  it('M6-11 matches a renamed file when every sheet has the same id and number in Revit', () => {
    const m = matchFile({ fileName: 'renamed.drawing', sheets: [{ id: '382617', number: 'A102' }] }, tower, sheets)
    expect(m).toEqual({ matches: true, by: 'sheets', sheetIds: ['382617'] })
  })

  it('M6-11 does not match another model, nor on the default project name alone', () => {
    expect(matchFile({ fileName: 'Office.drawing', model: 'Project Name', sheets: [{ id: '1', number: 'A102' }] }, tower, sheets).matches).toBe(false)
    // an id that exists with another number is not the same sheet
    expect(matchFile({ fileName: 'Office.drawing', sheets: [{ id: '382617', number: 'X1' }] }, tower, sheets).matches).toBe(false)
    expect(matchFile({ fileName: 'Tower A.drawing', sheets: [] }, null, []).matches).toBe(false)
  })

  it('M6-11 a .rvt matches by name with no sheets of its own', () => {
    expect(matchFile({ fileName: 'Tower A.rvt', sheets: [] }, tower, sheets)).toEqual({ matches: true, by: 'name', sheetIds: [] })
  })
})
