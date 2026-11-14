import { describe, expect, it } from 'vitest'
import { inferContext } from '../../../src/core/context'
import { PDFS, rawFor, score, truthFor } from './truth'

// Raw page content is cached by `pnpm exec tsx scripts/build-contexts.ts`.
describe('inferContext against fixtures/pdfs/*.truth.json (M2-02..M2-07)', () => {
  for (const pdf of PDFS.filter((p) => !p.startsWith('scanned'))) {
    truthFor(pdf).forEach((truth) => {
      const name = `${pdf} sheet ${truth.pageIndex}`
      it(`${name}: M2-02 walls recall and precision >= 0.9, none on dimensions/hatches/title block`, () => {
        const raw = rawFor(pdf, truth.pageIndex)
        expect(raw, 'run scripts/build-contexts.ts').not.toBeNull()
        const s = score(inferContext(raw!), truth)
        expect(s.wallRecall, `missed ${s.missedWalls.join(',')}`).toBeGreaterThanOrEqual(0.9)
        expect(s.wallPrecision, `false ${s.falseWalls.join(',')}`).toBeGreaterThanOrEqual(0.9)
        expect(s.wallsOnDistractors).toBe(0)
      })
      it(`${name}: M2-03 grids found with the right label`, () => {
        const s = score(inferContext(rawFor(pdf, truth.pageIndex)!), truth)
        expect(s.gridRecall).toBe(1)
        expect(s.gridLabelCorrect).toBe(1)
      })
      it(`${name}: M2-04 room labels, M2-05 scale = 100, openings >= 0.85`, () => {
        const ctx = inferContext(rawFor(pdf, truth.pageIndex)!)
        const s = score(ctx, truth)
        expect(s.labelRecall).toBe(1)
        expect(ctx.scale).toBe(100)
        expect(s.openingRecall).toBeGreaterThanOrEqual(0.85)
      })
      it(`${name}: M2-07 every item has confidence in [0,1]`, () => {
        const ctx = inferContext(rawFor(pdf, truth.pageIndex)!)
        expect(ctx.items.length).toBeGreaterThan(0)
        for (const it of ctx.items) {
          expect(it.confidence).toBeGreaterThanOrEqual(0)
          expect(it.confidence).toBeLessThanOrEqual(1)
        }
      })
    })
  }

  it('M2-06 scanned page gives an empty shapeOnly context', () => {
    const raw = rawFor('scanned-1-sheet.pdf', 0)
    expect(raw).not.toBeNull()
    expect(raw!.hasRasterOnly).toBe(true)
    const ctx = inferContext(raw!)
    expect(ctx.shapeOnly).toBe(true)
    expect(ctx.items).toHaveLength(0)
  })
})
