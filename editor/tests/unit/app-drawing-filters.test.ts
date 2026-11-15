/**
 * Display filters for `.drawing` pages (docs/tasks/V2-drawing-filters.md): categories (V2-01), item kinds (V2-02),
 * the annotation shortcut (V2-03).
 */
import { describe, expect, it } from 'vitest'
import type { DrawingDocument, DrawItem } from '@core/drawing'
import { categoriesOf, categoryName, filters, getFilters, hiddenPredicate, isAnnotationCategory, NO_CATEGORY } from '../../src/app/drawing/filters'

const common = { view: null }
const segs = (el: string | null): DrawItem => ({ t: 'segs', el, xy: new Float32Array(4), w: 1, c: [0, 0, 0], dash: [], ...common })
const text = (el: string | null): DrawItem => ({ t: 'text', el, text: 'x', at: { x: 0, y: 0 }, size: 2, anchor: 'lb', dir: { x: 1, y: 0 }, maxWidth: null, c: [0, 0, 0], bold: false, ...common })
const fill = (el: string | null): DrawItem => ({ t: 'fill', el, rings: [], c: [0, 0, 0], ...common })

const doc: DrawingDocument = {
  source: {},
  elements: { '1': { class: 'Wall', category: 'Walls' }, '2': { class: 'LinearDimString', category: null }, '3': { category: 'Grids' } },
  pages: [
    { id: 'a', kind: 'sheet', number: 'A1', name: 'P', scale: null, sizePt: { w: 10, h: 10 }, items: [segs('1'), segs('1'), fill('1'), text('2'), segs('2'), segs('3'), segs(null)] },
  ],
}

describe('V2-01 categories', () => {
  it('V2-01: category, else class label, else "No category"; counted over all pages, most first', () => {
    expect(categoryName({ class: 'LinearDimString' })).toBe('Linear dim string')
    expect(categoryName(undefined)).toBe(NO_CATEGORY)
    expect(categoriesOf(doc)).toEqual([
      { name: 'Walls', count: 3 },
      { name: 'Linear dim string', count: 2 },
      { name: 'Grids', count: 1 },
      { name: NO_CATEGORY, count: 1 },
    ])
  })
  it('V2-01: a hidden category drops its items; nothing hidden gives no predicate', () => {
    filters.reset()
    expect(hiddenPredicate(doc)).toBeNull()
    const v = getFilters().version
    filters.setCategoryHidden('Linear dim string', true)
    expect(getFilters().version).toBe(v + 1)
    const hide = hiddenPredicate(doc)!
    expect(doc.pages[0].items.filter((i) => !hide(i)).length).toBe(5)
    filters.reset()
  })
})

describe('V2-02 item kinds', () => {
  it('V2-02: hiding fills or text drops those items in every category', () => {
    filters.reset()
    filters.setKindHidden('fills', true)
    filters.setKindHidden('text', true)
    const hide = hiddenPredicate(doc)!
    expect(doc.pages[0].items.filter((i) => !hide(i)).map((i) => i.t)).toEqual(['segs', 'segs', 'segs', 'segs', 'segs'])
    filters.reset()
    expect(getFilters().hiddenKinds.size).toBe(0)
  })
})

describe('V2-03 annotation shortcut', () => {
  it('V2-03: dimensions, tags, grids, levels and title blocks count as annotation; model categories do not', () => {
    for (const n of ['Dimensions', 'Linear dim string', 'Room Tags', 'IndependentTag', 'Grids', 'Levels', 'Title Blocks', 'Text Notes']) expect(isAnnotationCategory(n), n).toBe(true)
    for (const n of ['Walls', 'Doors', 'Furniture', 'Rooms', 'Curtain Panels', 'Floors']) expect(isAnnotationCategory(n), n).toBe(false)
  })
})

describe('M3-03 erased elements are hidden', () => {
  it('M3-03: items of erased elements are hidden on top of the filters; Show all keeps them hidden', () => {
    filters.reset()
    filters.setErased(new Set(['1']))
    const hide = hiddenPredicate(doc, getFilters())!
    expect(doc.pages[0].items.filter((it) => !hide(it)).map((it) => it.el)).toEqual(['2', '2', '3', null])
    filters.reset()
    expect(getFilters().erased.has('1')).toBe(true)
    filters.setErased(new Set())
    expect(hiddenPredicate(doc, getFilters())).toBeNull()
  })
})
