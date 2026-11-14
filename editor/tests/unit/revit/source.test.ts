import { describe, expect, it } from 'vitest'
import { RevitSource } from '../../../src/app/revit/source'

const pkg = (id: string, elements: { id: string; x: number }[], w = 1191) => ({
  schemaVersion: 1,
  project: 'Tower A',
  sheets: [
    {
      id,
      number: `A-${id}`,
      name: `Sheet ${id}`,
      sizePt: { w, h: 842 },
      scale: 100,
      elements: elements.map((e) => ({ id: e.id, category: 'Walls', typeName: 'Generic - 200mm', footprint: [{ x: e.x, y: 100 }, { x: e.x, y: 500 }] })),
    },
  ],
})

describe('M6-04 RevitSource: one part per Revit sheet, replaced in place', () => {
  it('adds sheets in order with page indices, and gives each its package context under the Revit id', async () => {
    const src = new RevitSource('Tower A (Revit)', 'e1')
    expect(await src.setSheet('101', 1, pkg('101', [{ id: '9', x: 100 }]))).toBe(true)
    expect(await src.setSheet('102', 1, pkg('102', []))).toBe(true)
    const { sheets } = await src.load()
    expect(sheets.map((s) => [s.id, s.pageIndex, s.number])).toEqual([
      ['101', 0, 'A-101'],
      ['102', 1, 'A-102'],
    ])
    const ctx = await src.contextFor('101')
    expect(ctx.sheetId).toBe('101')
    expect(ctx.origin).toBe('package')
    expect(ctx.items.some((i) => i.hostRef === '9')).toBe(true)
    expect(src.project).toBe('Tower A')
  })

  it('a newer version replaces only its sheet: the other Sheet objects stay identical; older versions are ignored', async () => {
    const src = new RevitSource('T', 'e1')
    await src.setSheet('101', 1, pkg('101', []))
    await src.setSheet('102', 1, pkg('102', []))
    const a = (await src.load()).sheets
    expect(await src.setSheet('101', 2, pkg('101', [{ id: '42', x: 300 }]))).toBe(true)
    const b = (await src.load()).sheets
    expect(b[1]).toBe(a[1])
    expect(b[0]).not.toBe(a[0])
    expect(src.versionOf('101')).toBe(2)
    expect((await src.contextFor('101')).items.some((i) => i.hostRef === '42')).toBe(true)
    expect(await src.setSheet('101', 2, pkg('101', []))).toBe(false)
    expect(await src.setSheet('101', 1, pkg('101', []))).toBe(false)
    expect((await src.contextFor('101')).items.some((i) => i.hostRef === '42')).toBe(true)
  })

  it('after resetVersions (plugin restarted) version 1 wins again; removeSheet re-indexes the rest', async () => {
    const src = new RevitSource('T', 'e1')
    await src.setSheet('101', 5, pkg('101', []))
    await src.setSheet('102', 3, pkg('102', []))
    src.resetVersions()
    expect(await src.setSheet('101', 1, pkg('101', [{ id: '1', x: 10 }]))).toBe(true)
    src.removeSheet('101')
    const { sheets } = await src.load()
    expect(sheets.map((s) => [s.id, s.pageIndex])).toEqual([['102', 0]])
    expect(src.has('101')).toBe(false)
  })

  it('rejects a package that is not a drawing package', async () => {
    const src = new RevitSource('T', 'e1')
    await expect(src.setSheet('101', 1, { schemaVersion: 9 })).rejects.toThrow()
    expect(src.has('101')).toBe(false)
  })
})
