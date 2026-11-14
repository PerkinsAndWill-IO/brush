import { describe, expect, it } from 'vitest'
import { classifySheet, inferContext, parseScaleText, parseTitleBlock, sheetInfo } from '../../../src/core/context'
import { line, page, rect, text } from './helpers'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SheetContext } from '../../../src/core/types'
import { rawFor, root } from './truth'

describe('scale text (decision 0006)', () => {
  it('a company name like "1:1 landskab ApS" is not a scale; labelled ratios are', () => {
    expect(parseScaleText('1:1 landskab ApS')).toBeUndefined()
    expect(parseScaleText('1:1')).toBeUndefined()
    expect(parseScaleText('Målestok 1:1')).toBe(1)
    expect(parseScaleText('1:100 @ A1')).toBe(100)
    expect(parseScaleText('Échelle : 1:50')).toBe(50)
    expect(parseScaleText('1:20 (A3)')).toBe(20)
  })
  it('prefers the ratio next to a scale label', () => {
    const raw = page([line(1, 1, 5, 5)], [text('1 : 200', 300, 300, 8), text('Échelle :', 600, 560, 7), text('1 : 50', 650, 560, 7)])
    expect(inferContext(raw).scale).toBe(50)
  })
})

describe('sheet type (decision 0006)', () => {
  it('classifies by drawing-code type field, then title words', () => {
    expect(classifySheet({ number: 'KRO-APD-ARC-PLN-A1A-N01-0001-007' }).sheetType).toBe('plan')
    expect(classifySheet({ number: 'KRO-APD-ARC-ELE-A1A-TTN-0032-005' }).sheetType).toBe('elevation')
    expect(classifySheet({ number: 'KRO-APD-ARC-SYN-A1A-TTN-0061-004' }).sheetType).toBe('axonometric')
    expect(classifySheet({ number: 'A-301', name: 'BUILDING SECTIONS' }).sheetType).toBe('section')
    expect(classifySheet({ name: 'FACADE NORD' }).sheetType).toBe('elevation')
    expect(classifySheet({ name: 'LEVEL 2 FLOOR PLAN' }).sheetType).toBe('plan')
    expect(classifySheet({}).sheetType).toBe('unknown')
  })
  it('a drawing code and big title lines become number and name', () => {
    const raw = page(
      [],
      [text('KRO-APD-ARC-ELE-A1A-TTN-0032 - 005', 640, 580, 9), text('ÉLÉVATION GENERAL', 700, 540, 14), text('ÉLÉVATION NORD', 700, 560, 14), text('NOM DU PLAN', 640, 570, 5)],
    )
    expect(parseTitleBlock(raw)).toMatchObject({ number: 'KRO-APD-ARC-ELE-A1A-TTN-0032-005', name: 'ÉLÉVATION GENERAL · ÉLÉVATION NORD' })
  })
  it('no walls on a sheet titled as an elevation; same linework on an untitled sheet keeps them', () => {
    const walls = [line(100, 100, 400, 100), line(100, 108, 400, 108), line(100, 100, 100, 300), line(108, 108, 108, 300)]
    const frame = [rect(10, 10, 822, 575), rect(600, 480, 232, 105)]
    const elev = inferContext(page([...walls, ...frame], [text('SOUTH ELEVATION', 610, 520, 12), text('SCALE 1:100', 610, 550, 8)]))
    expect(elev.items.filter((i) => i.kind === 'wall')).toHaveLength(0)
    expect(sheetInfo(elev)?.sheetType).toBe('elevation')
    const plain = inferContext(page([...walls, ...frame], [text('SCALE 1:100', 610, 550, 8)]))
    expect(plain.items.filter((i) => i.kind === 'wall').length).toBeGreaterThan(0)
  })
})

describe('KRO real sheets (fixtures/contexts, from scripts/build-contexts.ts)', () => {
  const expected = [
    { sheetType: 'plan', number: 'KRO-APD-ARC-PLN-A1A-N01-0001-007', title: 'PLAN GENERAL · LOT A1A · PLAN N01', scale: 100 },
    { sheetType: 'elevation', number: 'KRO-APD-ARC-ELE-A1A-TTN-0032-005', title: 'ÉLÉVATION GENERAL · LOT A1A · ÉLÉVATION NORD', scale: 100 },
    { sheetType: 'axonometric', number: 'KRO-APD-ARC-SYN-A1A-TTN-0061-004', title: 'APERCU VOLUMETRIE · ET FACADE · LOT A1A · AXONOMETRIE', scale: undefined },
  ]
  expected.forEach((e, i) => {
    it(`page ${i}: ${e.sheetType}, number/title from the title block, scale ${e.scale ?? 'none'}; no plan geometry off plans`, () => {
      // raw content is cached only for sheets under 2 MB (scripts/build-contexts.ts); else check the built context
      const raw = rawFor('kro-project-3-sheets.pdf', i)
      const ctx = raw ? inferContext(raw) : contextFor('kro-project-3-sheets.pdf', i)
      expect(ctx, 'run scripts/build-contexts.ts').not.toBeNull()
      expect(sheetInfo(ctx!)).toMatchObject({ sheetType: e.sheetType, number: e.number, title: e.title, partial: false })
      expect(ctx!.scale).toBe(e.scale)
      const planGeom = ctx!.items.filter((it) => it.kind === 'wall' || it.kind === 'opening' || it.kind === 'fixture')
      if (e.sheetType !== 'plan') expect(planGeom).toHaveLength(0)
      // D: the vector plan has hundreds of wall runs (26 before poché polygons were read)
      else expect(ctx!.items.filter((it) => it.kind === 'wall').length).toBeGreaterThan(300)
    })
  })
  it('a tiny inference budget degrades to a partial context instead of blocking', () => {
    const ctx = inferContext(rawFor('kro-project-3-sheets.pdf', 1)!, { budgetMs: 0 })
    expect(sheetInfo(ctx)?.partial).toBe(true)
    expect(ctx.items.some((it) => it.kind === 'unknown' && it.props?.role === 'room')).toBe(false)
  })
})

function contextFor(pdf: string, page: number): SheetContext | null {
  const f = resolve(root, 'fixtures', 'contexts', `${pdf}.${page}.json`)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as SheetContext) : null
}
