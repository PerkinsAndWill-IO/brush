/**
 * M6-04 regression: a new Revit version of a sheet must reach the board as a new Sheet object, so its page is drawn
 * again. Its name, size and number stay the same, so a field comparison alone would keep the old (stale) page while
 * the stroke that made the wall is hidden, and the wall would vanish from the editor.
 */
import { describe, expect, it } from 'vitest'
import { RevitSource } from '../../../src/app/revit/source'
import { getDocState, openLinkedSource, refreshSource } from '../../../src/app/store'

const pkg = (walls: number[]) => ({
  schemaVersion: 1,
  project: 'Tower A',
  sheets: [
    {
      id: '103',
      number: 'A103',
      name: 'Third Floor Plan',
      sizePt: { w: 1191, h: 842 },
      scale: 100,
      elements: walls.map((x, i) => ({ id: `w${i}`, category: 'Walls', typeName: 'Generic - 200mm', footprint: [{ x, y: 100 }, { x, y: 500 }] })),
    },
  ],
})

describe('M6-04 refreshSource', () => {
  it('gives a changed sheet a new object even when its fields are the same, and keeps the others', async () => {
    const src = new RevitSource('Tower A (Revit)', 'e1')
    await src.setSheet('103', 1, pkg([]))
    await src.setSheet('104', 1, { ...pkg([]), sheets: [{ ...pkg([]).sheets[0], id: '104', number: 'A104' }] })
    await openLinkedSource(src)
    const [before103, before104] = getDocState().sheets

    expect(await src.setSheet('103', 2, pkg([300]))).toBe(true)
    await refreshSource(src, ['103'])

    const [after103, after104] = getDocState().sheets
    expect(JSON.stringify(after103)).toBe(JSON.stringify(before103))
    expect(after103).not.toBe(before103)
    expect(after104).toBe(before104)
  })

  it('keeps every sheet object when nothing is named as changed', async () => {
    const src = new RevitSource('Tower A (Revit)', 'e1')
    await src.setSheet('103', 1, pkg([]))
    await openLinkedSource(src)
    const before = getDocState().sheets
    await refreshSource(src, [])
    expect(getDocState().sheets[0]).toBe(before[0])
  })
})
