/** Erasing host elements of a `.drawing` page with the eraser (M3-03 delete): which elements an eraser path hits. */
import { describe, expect, it } from 'vitest'
import type { DrawingPage, DrawItem } from '@core/drawing'
import { elementsAlong } from '../../src/app/drawing/inspect'

const common = { view: null }
const seg = (el: string | null, x0: number, y0: number, x1: number, y1: number): DrawItem => ({ t: 'segs', el, xy: new Float32Array([x0, y0, x1, y1]), w: 1, c: [0, 0, 0], dash: [], ...common })
const fill = (el: string, ring: number[]): DrawItem => ({ t: 'fill', el, rings: [new Float32Array(ring)], c: [0, 0, 0], ...common })
const page: DrawingPage = {
  id: 'A1', kind: 'sheet', number: 'A1', name: 'A1', scale: null, sizePt: { w: 1000, h: 800 },
  items: [
    fill('room', [0, 0, 400, 0, 400, 400, 0, 400]), // room fill under everything
    fill('wall', [100, 98, 300, 98, 300, 102, 100, 102]), // cut wall: fill plus its outline
    seg('wall', 100, 98, 300, 98),
    seg('wall', 100, 102, 300, 102),
    seg('grid', 200, 0, 200, 400), // grid line crossing the wall
    seg('dim', 100, 300, 300, 300), // a dimension line
    seg('door', 100, 250, 140, 250),
    seg(null, 0, 500, 400, 500), // anonymous line outside the room (title block, no element)
  ],
}

describe('M3-03 eraser over a .drawing page, any category', () => {
  it('M3-03: scrubbing along a wall erases the wall, not the grid it crosses or the room under it', () => {
    expect(elementsAlong(page, [{ x: 120, y: 100 }, { x: 280, y: 100 }, { x: 130, y: 99 }], 3)).toEqual(['wall'])
  })

  it('M3-03: annotation is erasable: scrubbing a grid or a dimension erases it', () => {
    expect(elementsAlong(page, [{ x: 200, y: 160 }, { x: 200, y: 240 }, { x: 200, y: 170 }], 3)).toEqual(['grid'])
    expect(elementsAlong(page, [{ x: 110, y: 300 }, { x: 190, y: 300 }], 3)).toEqual(['dim'])
  })

  it('M3-03: scrubbing inside a room, away from any line, erases the room', () => {
    expect(elementsAlong(page, [{ x: 30, y: 150 }, { x: 60, y: 200 }, { x: 30, y: 220 }], 3)).toEqual(['room'])
  })

  it('M3-03: one pass over two elements erases each once, in path order', () => {
    expect(elementsAlong(page, [{ x: 105, y: 250 }, { x: 135, y: 250 }, { x: 140, y: 100 }, { x: 180, y: 100 }], 3)).toEqual(['door', 'wall'])
  })

  it('M3-03: anonymous lines and already hidden elements are never erased', () => {
    expect(elementsAlong(page, [{ x: 10, y: 500 }, { x: 390, y: 500 }], 3)).toEqual([])
    expect(elementsAlong(page, [{ x: 120, y: 100 }, { x: 280, y: 100 }], 3, (it) => it.el === 'wall' || it.el === 'room')).toEqual(['grid'])
  })
})
