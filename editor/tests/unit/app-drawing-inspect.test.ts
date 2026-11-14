/**
 * Inspecting host elements (docs/tasks/V3-inspect.md): hit-testing a page (V3-01), tag resolution and card labels
 * (V3-02), finding an element on every page (V3-03).
 */
import { describe, expect, it, vi } from 'vitest'
import type { DrawingPage, DrawItem } from '@core/drawing'
import { buildPageHitIndex, hitItem, pageHitIndexSteps, roughMeasure, textQuad } from '../../src/app/drawing/hit'
import { splitUnit } from '../../src/app/drawing/InspectLayers'
import { cardCategory, elementAt, elementAtIfReady, inspect, onHitIndexReady, getInspect, itemsOf, paramLabel, resolveElement } from '../../src/app/drawing/inspect'

const common = { view: null }
const seg = (el: string | null, x0: number, y0: number, x1: number, y1: number, w = 1): DrawItem => ({ t: 'segs', el, xy: new Float32Array([x0, y0, x1, y1]), w, c: [0, 0, 0], dash: [], ...common })
const path = (el: string | null, xy: number[], closed = false): DrawItem => ({ t: 'path', el, xy: new Float32Array(xy), closed, w: 0.5, c: [0, 0, 0], dash: [], ...common })
const fill = (el: string | null, ring: number[]): DrawItem => ({ t: 'fill', el, rings: [new Float32Array(ring)], c: [0, 0, 0], ...common })
const text = (el: string | null, s: string, x: number, y: number, anchor = 'lb', dir = { x: 1, y: 0 }): DrawItem => ({
  t: 'text', el, text: s, at: { x, y }, size: 7.16, anchor, dir, maxWidth: null, c: [0, 0, 0], bold: false, ...common,
})
const page = (id: string, items: DrawItem[]): DrawingPage => ({ id, kind: 'sheet', number: id, name: id, scale: null, sizePt: { w: 1000, h: 800 }, items })

describe('V3-01 hit-testing', () => {
  const p = page('A1', [
    fill('10', [100, 100, 300, 100, 300, 300, 100, 300]), // 0: room fill
    seg('20', 100, 100, 300, 100, 2), // 1: wall on the fill's top edge
    path('30', [500, 500, 600, 500, 600, 600]), // 2
    seg(null, 0, 700, 1000, 700), // 3: no element (title block line)
    seg('40', 0, 702, 1000, 702), // 4: element just below the anonymous line
    text('50', 'ROOM', 150, 200), // 5
  ])
  const ix = buildPageHitIndex(p, roughMeasure)
  const at = (x: number, y: number, tol = 3, skip?: (it: DrawItem) => boolean) => {
    const i = hitItem(ix, x, y, tol, skip)
    return i < 0 ? null : p.items[i].el
  }

  it('V3-01: strokes and text win over fills; inside a fill picks the fill; outside picks nothing', () => {
    expect(at(200, 101)).toBe('20')
    expect(at(150, 197)).toBe('50')
    expect(at(250, 250)).toBe('10')
    expect(at(400, 400)).toBeNull()
    expect(at(600, 550)).toBe('30')
  })

  it('V3-01: items without an element and filtered items are passed over', () => {
    expect(at(500, 700)).toBe('40')
    expect(at(200, 101, 3, (it) => it.t === 'segs')).toBe('10')
  })

  it('V3-01: the pick radius is respected', () => {
    expect(at(200, 106, 2)).toBe('10') // 6 pt off the wall: the fill underneath
    expect(at(200, 94, 2)).toBeNull()
    expect(at(200, 94, 7)).toBe('20')
  })

  it('V3-01: a text box follows its anchor and direction', () => {
    const q = textQuad(text('1', 'AB', 0, 0, 'cm', { x: 0, y: -1 }) as Extract<DrawItem, { t: 'text' }>, () => 20)
    // rotated to read upwards, centred on the anchor: 20 long in y, one line tall in x
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20)
    expect(Math.max(...ys) + Math.min(...ys)).toBeCloseTo(0)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(12)
  })

  it('V3-01: elementAt caches the index per page', () => {
    expect(elementAt(p, 200, 101, 3)).toBe('20')
    expect(elementAt(p, 400, 400, 3)).toBeNull()
  })

  it('V3-01: a large page builds and answers quickly', () => {
    const items: DrawItem[] = []
    for (let i = 0; i < 50_000; i++) items.push(seg(String(i), (i * 7) % 1000, (i * 13) % 800, ((i * 7) % 1000) + 5, ((i * 13) % 800) + 3))
    const big = page('B', items)
    const t0 = performance.now()
    const bix = buildPageHitIndex(big, roughMeasure)
    const build = performance.now() - t0
    const t1 = performance.now()
    for (let k = 0; k < 1000; k++) hitItem(bix, (k * 37) % 1000, (k * 53) % 800, 2)
    const per = (performance.now() - t1) / 1000
    expect(build).toBeLessThan(1500)
    expect(per).toBeLessThan(1)
  })
})

describe('V3-01 the hit index is built in slices', () => {
  const items: DrawItem[] = []
  for (let i = 0; i < 40_000; i++) items.push(seg(String(i), (i * 7) % 1000, (i * 13) % 800, ((i * 7) % 1000) + 5, ((i * 13) % 800) + 3))
  const big = page('S', items)

  it('a 40k-segment page takes several steps and ends with the same answers as the one-shot build', () => {
    const steps = pageHitIndexSteps(big, roughMeasure)
    let yields = 0
    let r = steps.next()
    while (!r.done) {
      yields++
      r = steps.next()
    }
    expect(yields).toBeGreaterThanOrEqual(4)
    const once = buildPageHitIndex(big, roughMeasure)
    for (const [x, y] of [[3, 2], [212, 205], [500, 391]]) expect(hitItem(r.value, x, y, 2)).toBe(hitItem(once, x, y, 2))
  })

  it('elementAtIfReady answers null while a page is being indexed and the element once it is warm', async () => {
    const warm = page('W', [seg('20', 100, 100, 300, 100, 2)])
    const ready = vi.fn()
    const off = onHitIndexReady(ready)
    expect(elementAtIfReady(warm, 200, 101, 3)).toBeNull()
    await vi.waitFor(() => expect(elementAtIfReady(warm, 200, 101, 3)).toBe('20'))
    expect(ready).toHaveBeenCalledTimes(1) // a resting pointer gets to look again
    off()
    expect(elementAtIfReady(warm, 400, 400, 3)).toBeNull()
  })
})

describe('V3-02 element panel', () => {
  const elements = {
    '1': { class: 'Room', category: 'Rooms', name: 'Kitchen', level: 'Level 1', params: [{ name: 'ROOM_AREA', value: '12 m²' }] },
    '2': { class: 'RoomTag', category: 'Room Tags', tagged: 1 },
    '3': { class: 'LinearDimString' },
  }
  it('V3-02: a tag resolves to the element it labels and highlights both', () => {
    expect(resolveElement(elements, '2')).toMatchObject({ id: '1', tagLabel: 'Room tag', highlight: ['2', '1'] })
    expect(resolveElement(elements, '1')).toMatchObject({ id: '1', tagLabel: null, highlight: ['1'] })
    expect(resolveElement(elements, '9')).toMatchObject({ id: '9', info: undefined, highlight: ['9'] })
  })
  it('V3-02: a trailing unit is split off the value', () => {
    expect(splitUnit('-639.9999 Millimeters')).toEqual(['-639.9999', 'Millimeters'])
    expect(splitUnit('0 Degrees')).toEqual(['0', 'Degrees'])
    expect(splitUnit('12 m²')).toEqual(['12', 'm²'])
    expect(splitUnit('Level 1')).toEqual(['Level 1', ''])
    expect(splitUnit('800 x 2100')).toEqual(['800 x 2100', ''])
  })
  it('V3-02: readable labels', () => {
    expect(paramLabel('ROOM_AREA')).toBe('Room area')
    expect(paramLabel('Comments')).toBe('Comments')
    expect(cardCategory(elements['3'])).toBe('Linear dim string')
    expect(cardCategory(undefined)).toBe('Element')
  })
  it('V3-02: hover follows the pointer until a click pins; unpin releases', () => {
    inspect.clear()
    inspect.hover('1')
    expect(getInspect()).toEqual({ hover: '1', pinned: null })
    inspect.pin('2')
    inspect.hover('3') // ignored while pinned
    expect(getInspect()).toEqual({ hover: '2', pinned: '2' })
    expect(inspect.unpin()).toBe(true)
    expect(getInspect()).toEqual({ hover: null, pinned: null })
    expect(inspect.unpin()).toBe(false)
  })
})

describe('V3-03 every sheet', () => {
  it('V3-03: items of the highlighted elements on a page, in draw order', () => {
    const a = page('A', [seg('1', 0, 0, 1, 1), seg('2', 0, 0, 1, 1), seg('1', 0, 0, 2, 2)])
    const b = page('B', [seg('2', 0, 0, 1, 1)])
    expect(itemsOf(a, ['2', '1'])).toEqual([a.items[0], a.items[1], a.items[2]])
    expect(itemsOf(b, ['1'])).toEqual([])
    expect(itemsOf(b, ['1', '2'])).toEqual([b.items[0]])
  })
})
