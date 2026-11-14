/**
 * Picking on a `.drawing` page: the item under a point of the sheet (sheet points, y down). Literal geometry.
 */
import { describe, expect, it } from 'vitest'
import { buildHitIndex, hitIndexSteps, hitTest, type DrawingPage, type DrawItem } from '@core/drawing'

const view = null
const black: [number, number, number] = [0, 0, 0]
const segs = (el: string | null, xy: number[], w = 1): DrawItem => ({ t: 'segs', el, view, xy: new Float32Array(xy), w, c: black, dash: [] })
const path = (el: string | null, xy: number[], closed: boolean, w = 1): DrawItem => ({ t: 'path', el, view, xy: new Float32Array(xy), closed, w, c: black, dash: [] })
const fill = (el: string | null, ...rings: number[][]): DrawItem => ({ t: 'fill', el, view, rings: rings.map((r) => new Float32Array(r)), c: black })
const text = (el: string | null, s: string, at: [number, number], dir: [number, number], anchor: string): DrawItem => ({
  t: 'text',
  el,
  view,
  text: s,
  at: { x: at[0], y: at[1] },
  size: 7.16,
  anchor,
  dir: { x: dir[0], y: dir[1] },
  maxWidth: null,
  c: black,
  bold: false,
})
const image = (el: string | null, x: number, y: number, w: number, h: number): DrawItem => ({ t: 'image', el, view, rect: { x, y, w, h }, png: new Uint8Array(0) })
const pageOf = (items: DrawItem[]): DrawingPage => ({ id: 'p', kind: 'sheet', number: null, name: 'P', scale: null, sizePt: { w: 300, h: 150 }, items })

/** Half an em per character; the em of the texts below is 7.16 / 0.716 = 10 points. */
const measure = (s: string, em: number) => s.length * em * 0.5

// 0 room fill, 1 wall over it, 2 open door path, 3 closed box path, 4 label, 5 picture, 6 vertical text
const page = pageOf([
  fill('room', [10, 10, 90, 10, 90, 90, 10, 90]),
  segs('wall', [50, 10, 50, 90], 2),
  path('door', [120, 20, 150, 20, 150, 60], false),
  path('box', [160, 10, 190, 10, 190, 40, 160, 40], true),
  text('label', 'AB', [120, 80], [1, 0], 'lb'),
  image('pic', 150, 70, 30, 20),
  text('vert', 'XYZW', [250, 10], [0, 1], 'lt'),
])
const index = buildHitIndex(page, measure)
const hit = (x: number, y: number, tol = 2) => hitTest(index, x, y, tol)

describe('hit testing a .drawing page', () => {
  it('a point inside a fill picks the fill, a point outside its rings picks nothing', () => {
    expect(hit(20, 50)).toBe(0)
    expect(hit(95, 50)).toBe(-1)
  })

  it('a stroke wins over the fill it lies on, within the pick radius or half its width', () => {
    expect(hit(51.5, 50)).toBe(1)
    expect(hit(52.5, 50)).toBe(0) // 2.5 away from the wall: only the fill is under it
    expect(hit(53.5, 50, 4)).toBe(1) // a wider radius reaches it
  })

  it('a stroke reaches a pointer within tol of its segments, also past the end of a polyline', () => {
    expect(hit(135, 21.5)).toBe(2)
    expect(hit(151.5, 40)).toBe(2)
    expect(hit(135, 24)).toBe(-1)
  })

  it('a closed path also picks along its closing segment', () => {
    expect(hit(161, 25)).toBe(3) // the left edge, from the last point back to the first
    expect(hit(175, 41)).toBe(3)
    expect(hit(175, 25)).toBe(-1) // inside the box, which is only an outline
  })

  it('a text is picked by its box: anchored at the left baseline, 10 x 12 points above it', () => {
    expect(hit(125, 74)).toBe(4)
    expect(hit(131, 74, 0.5)).toBe(-1)
    expect(hit(125, 66, 0.5)).toBe(-1)
  })

  it('a rotated text is picked in its own frame', () => {
    // reads downwards from (250, 10): 20 points along y, and 12 points to the left of the baseline
    expect(hit(244, 20, 0.5)).toBe(6)
    expect(hit(256, 20, 0.5)).toBe(-1)
    expect(hit(244, 35, 0.5)).toBe(-1)
  })

  it('an image is picked by its rectangle', () => {
    expect(hit(160, 80)).toBe(5)
    expect(hit(185, 80)).toBe(-1)
  })

  it('of two strokes on the same spot the later drawn one wins', () => {
    const p = buildHitIndex(pageOf([segs('a', [10, 10, 60, 10]), segs('b', [20, 10, 80, 10]), segs('c', [0, 10, 100, 10], 0.2)]), measure)
    expect(hitTest(p, 30, 10, 1)).toBe(2)
    expect(hitTest(p, 70, 10, 1)).toBe(2)
  })

  it('a hole of an even-odd fill is not picked', () => {
    const ring = (a: number, b: number) => [a, a, b, a, b, b, a, b]
    const p = buildHitIndex(pageOf([fill('slab', ring(10, 90), ring(40, 60))]), measure)
    expect(hitTest(p, 20, 20, 1)).toBe(0)
    expect(hitTest(p, 50, 50, 1)).toBe(-1)
  })

  it('items a display filter hides are skipped', () => {
    const noWalls = (it: DrawItem) => it.el === 'wall'
    expect(hitTest(index, 50, 50, 2, noWalls)).toBe(0)
    expect(hitTest(index, 50, 50, 2, null)).toBe(1)
  })

  it('lists the items of each element', () => {
    const p = buildHitIndex(pageOf([segs('w', [0, 0, 1, 1]), fill(null, [0, 0, 5, 0, 5, 5]), segs('w', [2, 2, 3, 3]), segs('x', [4, 4, 5, 5])]), measure)
    expect(p.byElement.get('w')).toEqual([0, 2])
    expect(p.byElement.get('x')).toEqual([3])
    expect(p.byElement.size).toBe(2)
  })

  it('building in steps gives the same answers, and yields on a big page', () => {
    // 20,000 horizontal lines 0.0075 apart, and one short line below them
    const xy: number[] = []
    for (let k = 0; k < 20_000; k++) xy.push(0, k * 0.0075, 100, k * 0.0075)
    const big = pageOf([segs('lines', xy, 0.001), segs('last', [10, 149, 20, 149], 0.001)])
    const steps = hitIndexSteps(big, measure)
    let yields = 0
    let r = steps.next()
    for (; !r.done; r = steps.next()) yields++
    expect(yields).toBeGreaterThan(2)
    expect(hitTest(r.value, 15, 149, 0.1)).toBe(1)
    expect(hitTest(r.value, 50, 12_345 * 0.0075, 0.001)).toBe(0)
  })
})
