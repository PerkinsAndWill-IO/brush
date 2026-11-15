/**
 * Spatial culling of `.drawing` pages (PERF-01): a region render (the zoomed-in detail raster) strokes only the
 * batches that reach into the region.
 * Path2D is a browser API: a recorder stands in for it.
 */
import { describe, expect, it } from 'vitest'
import type { DrawingPage, DrawItem } from '@core/drawing'
import { compile, partsIn } from '../../src/app/drawing/render'

class RecPath {
  ops: string[] = []
  moveTo(x: number, y: number) {
    this.ops.push(`M${x},${y}`)
  }
  lineTo(x: number, y: number) {
    this.ops.push(`L${x},${y}`)
  }
  closePath() {
    this.ops.push('Z')
  }
}
const rec = () => new RecPath() as unknown as Path2D
const ops = (p: Path2D) => (p as unknown as RecPath).ops

const common = { el: null, view: null }
const path = (xy: number[], w = 1): DrawItem => ({ t: 'path', xy: new Float32Array(xy), closed: false, w, c: [0, 0, 0], dash: [], ...common })
const segs = (xy: number[]): DrawItem => ({ t: 'segs', xy: new Float32Array(xy), w: 1, c: [0, 0, 0], dash: [], ...common })
const fill = (ring: number[]): DrawItem => ({ t: 'fill', rings: [new Float32Array(ring)], c: [9, 9, 9], ...common })
const page = (items: DrawItem[]): DrawingPage => ({ items, sizePt: { w: 3200, h: 3200 } }) as unknown as DrawingPage

describe('drawing render culling', () => {
  it('PERF-01: strokes far apart land in separate buckets and a region strokes only the one it touches', () => {
    const cmds = compile(page([path([10, 10, 20, 20]), path([3000, 3000, 3010, 3010])]), null, rec)
    expect(cmds).toHaveLength(1)
    const stroke = cmds[0]
    if (stroke.k !== 'stroke') throw new Error('expected a stroke command')
    expect(stroke.parts).toHaveLength(2)
    const hit = partsIn(stroke, { x: 0, y: 0, w: 100, h: 100 }, 0.1)
    expect(hit.map((p) => ops(p.path))).toEqual([['M10,10', 'L20,20']])
    expect(partsIn(stroke, { x: 0, y: 0, w: 3200, h: 3200 }, 0.1)).toHaveLength(2)
  })

  it('PERF-01: independent segments of one item are bucketed one by one', () => {
    const [stroke] = compile(page([segs([10, 10, 20, 20, 3000, 3000, 3010, 3010])]), null, rec)
    if (stroke.k !== 'stroke') throw new Error('expected a stroke command')
    expect(partsIn(stroke, { x: 2900, y: 2900, w: 200, h: 200 }, 0.1).map((p) => ops(p.path))).toEqual([['M3000,3000', 'L3010,3010']])
  })

  it('PERF-01: a long line is kept whole and drawn by any region it crosses', () => {
    const [stroke] = compile(page([path([0, 1600, 3200, 1600])]), null, rec)
    if (stroke.k !== 'stroke') throw new Error('expected a stroke command')
    expect(partsIn(stroke, { x: 1500, y: 1550, w: 100, h: 100 }, 0.1)).toHaveLength(1)
    expect(partsIn(stroke, { x: 1500, y: 100, w: 100, h: 100 }, 0.1)).toHaveLength(0)
  })

  it('PERF-01: the stroke width counts when a line only grazes the region', () => {
    const [stroke] = compile(page([path([10, 10, 20, 10], 8)]), null, rec)
    if (stroke.k !== 'stroke') throw new Error('expected a stroke command')
    expect(partsIn(stroke, { x: 0, y: 12, w: 100, h: 100 }, 0.1)).toHaveLength(1)
  })

  it('PERF-01: draw order across kinds is kept (stroke, fill, stroke)', () => {
    const cmds = compile(page([path([0, 0, 1, 1]), fill([0, 0, 5, 0, 5, 5]), path([2, 2, 3, 3])]), null, rec)
    expect(cmds.map((c) => c.k)).toEqual(['stroke', 'fill', 'stroke'])
  })

  it('PERF-01: one bucket splits before a Path2D passes 100k points', () => {
    const xy: number[] = []
    for (let i = 0; i < 60_000; i++) xy.push(10 + (i % 50) * 0.1, 10, 10 + (i % 50) * 0.1, 11)
    const items = [segs(xy.slice(0, 2 * 60_000)), segs(xy.slice(2 * 60_000))]
    const [stroke] = compile(page(items), null, rec)
    if (stroke.k !== 'stroke') throw new Error('expected a stroke command')
    expect(stroke.parts.map((p) => p.points)).toEqual([100_000, 20_000])
  })
})
