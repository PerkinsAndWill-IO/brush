/** Erasing host elements of a `.drawing` page with the eraser (M3-03 delete): which elements an eraser path hits. */
import { describe, expect, it } from 'vitest'
import type { DrawingDocument, DrawingPage, DrawItem } from '@core/drawing'
import { elementsAlong } from '../../src/app/drawing/inspect'

const common = { view: null }
const seg = (el: string | null, x0: number, y0: number, x1: number, y1: number): DrawItem => ({ t: 'segs', el, xy: new Float32Array([x0, y0, x1, y1]), w: 1, c: [0, 0, 0], dash: [], ...common })
const fill = (el: string, ring: number[]): DrawItem => ({ t: 'fill', el, rings: [new Float32Array(ring)], c: [0, 0, 0], ...common })
const page: DrawingPage = {
  id: 'A1', kind: 'sheet', number: 'A1', name: 'A1', scale: null, sizePt: { w: 1000, h: 800 },
  items: [
    fill('room', [0, 0, 400, 0, 400, 400, 0, 400]), // room fill under everything
    fill('wall', [100, 98, 300, 98, 300, 102, 100, 102]), // cut wall (a fill, as plans export them)
    seg('grid', 200, 0, 200, 400), // grid line crossing the wall
    seg('door', 100, 300, 140, 300),
    seg(null, 0, 350, 400, 350), // anonymous line
  ],
}
const doc: Pick<DrawingDocument, 'elements'> = {
  elements: { room: { category: 'Rooms' }, wall: { category: 'Walls' }, grid: { category: 'Grids' }, door: { category: 'Doors' } },
}

describe('M3-03 eraser over a .drawing page', () => {
  it('M3-03: an eraser pass across a wall erases the wall, not the room under it or the grid crossing it', () => {
    expect(elementsAlong(page, doc, [{ x: 180, y: 60 }, { x: 220, y: 140 }], 3)).toEqual(['wall'])
  })

  it('M3-03: a pass over several elements erases each once, in path order', () => {
    expect(elementsAlong(page, doc, [{ x: 120, y: 290 }, { x: 120, y: 310 }, { x: 150, y: 100 }, { x: 160, y: 100 }], 3)).toEqual(['door', 'wall'])
  })

  it('M3-03: over a room, anonymous lines or an already hidden element nothing is erased', () => {
    expect(elementsAlong(page, doc, [{ x: 50, y: 200 }, { x: 60, y: 350 }], 3)).toEqual([])
    expect(elementsAlong(page, doc, [{ x: 180, y: 60 }, { x: 220, y: 140 }], 3, (it) => it.el === 'wall')).toEqual([])
  })
})
