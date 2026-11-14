import { describe, expect, it } from 'vitest'
import { inferContext, parseTitleBlock, roomAt } from '../../../src/core/context'
import { arc, circle, line, page, rect, text } from './helpers'

const kinds = (ctx: ReturnType<typeof inferContext>, k: string) => ctx.items.filter((i) => i.kind === k)

describe('inferContext walls', () => {
  it('two parallel lines 7pt apart make one wall with centerline between', () => {
    const ctx = inferContext(page([line(100, 100, 300, 100), line(100, 107, 300, 107)]))
    const walls = kinds(ctx, 'wall')
    expect(walls).toHaveLength(1)
    const pts = walls[0].geometry.points
    expect(pts[0].y).toBeCloseTo(103.5)
    expect(pts[1].y).toBeCloseTo(103.5)
    expect(Math.abs(pts[1].x - pts[0].x)).toBeCloseTo(200)
    expect(walls[0].props?.thicknessPt).toBe('7')
    expect(walls[0].confidence).toBeGreaterThanOrEqual(0.3)
    expect(ctx.origin).toBe('inferred')
  })

  it('merges collinear runs split by a junction', () => {
    const ctx = inferContext(page([line(100, 100, 200, 100), line(200, 100, 300, 100), line(100, 107, 220, 107), line(220, 107, 300, 107)]))
    expect(kinds(ctx, 'wall')).toHaveLength(1)
  })

  it('does not treat a dimension line with ticks and "3500" as a wall', () => {
    const paths = [line(100, 200, 450, 200, 0.3), line(100, 194, 100, 206, 0.3), line(450, 194, 450, 206, 0.3)]
    const ctx = inferContext(page(paths, [text('3500', 255, 196, 8)]))
    expect(kinds(ctx, 'wall')).toHaveLength(0)
    const label = kinds(ctx, 'label')[0]
    expect(label.props?.role).toBe('dimension')
  })

  it('rejects a 45 degree hatch pattern', () => {
    const paths = []
    for (let i = 0; i < 14; i++) paths.push(line(200 + i * 4, 200, 200 + i * 4 - 30, 230, 0.25))
    const ctx = inferContext(page(paths))
    expect(kinds(ctx, 'wall')).toHaveLength(0)
  })

  it('finds a thick single stroke as a wall', () => {
    const ctx = inferContext(page([line(100, 100, 300, 100, 2.5)]))
    const w = kinds(ctx, 'wall')
    expect(w).toHaveLength(1)
    expect(w[0].props?.thicknessPt).toBe('2.5')
  })

  it('ignores short thick strokes and tiny clutter', () => {
    const ctx = inferContext(page([line(100, 100, 110, 100, 2.5), line(300, 300, 305, 301)]))
    expect(kinds(ctx, 'wall')).toHaveLength(0)
  })

  it('excludes title block lines from walls', () => {
    const paths = [rect(10, 10, 822, 575), rect(600, 480, 232, 105), line(610, 500, 820, 500, 0.5), line(610, 507, 820, 507, 0.5)]
    const ctx = inferContext(page(paths, [text('A-201', 700, 570, 14)]))
    expect(kinds(ctx, 'wall')).toHaveLength(0)
  })
})

describe('grids', () => {
  it('dash-dot line with bubble "B" is a grid labelled B', () => {
    const paths = [line(300, 80, 300, 500, 0.5, [12, 3, 2, 3]), circle(300, 66, 12)]
    const ctx = inferContext(page(paths, [text('B', 296, 70, 10, 8)]))
    const g = kinds(ctx, 'grid')
    expect(g).toHaveLength(1)
    expect(g[0].text).toBe('B')
    expect(g[0].confidence).toBeGreaterThan(0.8)
    expect(kinds(ctx, 'wall')).toHaveLength(0)
    expect(kinds(ctx, 'label')[0].props?.role).toBe('grid')
  })

  it('a long dashed line without bubble or label is not a grid', () => {
    const ctx = inferContext(page([line(300, 80, 300, 500, 0.5, [6, 3])]))
    expect(kinds(ctx, 'grid')).toHaveLength(0)
  })
})

describe('openings', () => {
  it('a wall gap bridged by a door swing arc is an opening', () => {
    // wall along y=100..107, gap x 200..230
    const paths = [
      line(100, 100, 200, 100), line(100, 107, 200, 107),
      line(230, 100, 330, 100), line(230, 107, 330, 107),
      arc(200, 100, 30, 0, Math.PI / 2), // hinge at gap start, swinging down
    ]
    const ctx = inferContext(page(paths))
    const o = kinds(ctx, 'opening')
    expect(o).toHaveLength(1)
    expect(Number(o[0].props?.widthPt)).toBeCloseTo(30, 0)
    const xs = o[0].geometry.points.map((p) => p.x).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(200, 0)
    expect(xs[1]).toBeCloseTo(230, 0)
  })

  it('a gap without an arc is not reported', () => {
    const paths = [line(100, 100, 200, 100), line(100, 107, 200, 107), line(230, 100, 330, 100), line(230, 107, 330, 107)]
    expect(kinds(inferContext(page(paths)), 'opening')).toHaveLength(0)
  })
})

describe('scale and title block', () => {
  it('parses SCALE 1:100', () => {
    expect(inferContext(page([line(1, 1, 5, 5)], [text('SCALE 1:100', 700, 560, 8)])).scale).toBe(100)
    expect(inferContext(page([line(1, 1, 5, 5)], [text('1 : 50', 700, 560, 8)])).scale).toBe(50)
  })
  it('parses imperial 1/4" = 1\'-0"', () => {
    expect(inferContext(page([line(1, 1, 5, 5)], [text('SCALE: 1/4" = 1\'-0"', 700, 560, 8)])).scale).toBe(48)
  })
  it('parseTitleBlock gets number, name and scale', () => {
    const raw = page(
      [rect(10, 10, 822, 575), rect(600, 480, 232, 105)],
      [text('A-201', 760, 570, 16), text('LEVEL 2 FLOOR PLAN', 610, 520, 12), text('SCALE 1:200', 610, 550, 8), text('PROJECT TOWER', 610, 495, 8)],
    )
    expect(parseTitleBlock(raw)).toEqual({ number: 'A-201', name: 'LEVEL 2 FLOOR PLAN', scale: 200 })
  })
})

describe('rooms and labels', () => {
  const walls = () => {
    // outer rect 200..500 x 150..350, thickness 8, lines as separate segments
    const p = [
      line(200, 150, 500, 150), line(200, 158, 500, 158),
      line(200, 342, 500, 342), line(200, 350, 500, 350),
      line(200, 150, 200, 350), line(208, 158, 208, 342),
      line(500, 150, 500, 350), line(492, 158, 492, 342),
    ]
    return p
  }

  it('OFFICE 201 is a room label and roomAt returns it inside four walls', () => {
    const ctx = inferContext(page(walls(), [text('OFFICE 201', 320, 255, 10), text('SCALE 1:100', 20, 580, 8)]))
    expect(kinds(ctx, 'wall').length).toBeGreaterThanOrEqual(4)
    const lab = kinds(ctx, 'label').find((l) => l.text === 'OFFICE 201')!
    expect(lab.props?.role).toBe('room')
    const r = roomAt(ctx, { x: 350, y: 250 })
    expect(r.label).toBe('OFFICE 201')
    expect(r.polygon?.closed).toBe(true)
    // clear interior is ~284 x 184 pt = ~10 m x 6.5 m at 1:100, about 65 m2 less raster erosion
    expect(r.areaM2).toBeGreaterThan(55)
    expect(r.areaM2).toBeLessThan(70)
    expect(roomAt(ctx, { x: 100, y: 100 }).polygon).toBeUndefined()
  })

  it('places furniture symbols inside rooms as fixtures', () => {
    const ctx = inferContext(page([...walls(), rect(300, 200, 40, 20), circle(450, 300, 8)], [text('SCALE 1:100', 20, 580, 8)]))
    expect(kinds(ctx, 'fixture').length).toBe(2)
    // and not as walls
    expect(kinds(ctx, 'wall').length).toBe(4)
  })

  it('assigns stable deterministic ids', () => {
    const a = inferContext(page(walls(), [text('OFFICE 201', 320, 255, 10)]))
    const b = inferContext(page(walls().reverse(), [text('OFFICE 201', 320, 255, 10)]))
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id))
    expect(a.items.map((i) => i.id)).toEqual([...new Set(a.items.map((i) => i.id))])
  })
})

describe('shape-only pages', () => {
  it('raster page yields no items and shapeOnly', () => {
    const ctx = inferContext({ sheetId: 's', sizePt: { w: 600, h: 800 }, paths: [], texts: [], hasRasterOnly: true })
    expect(ctx.items).toEqual([])
    expect(ctx.shapeOnly).toBe(true)
  })
  it('empty page yields shapeOnly', () => {
    expect(inferContext(page()).shapeOnly).toBe(true)
  })
})

describe('perf', () => {
  it('5,000 random segments in under 1 s', () => {
    let seed = 12345
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
    const paths = []
    for (let i = 0; i < 5000; i++) {
      const x = rnd() * 800
      const y = rnd() * 550
      const a = rnd() < 0.7 ? (rnd() < 0.5 ? 0 : Math.PI / 2) : rnd() * Math.PI
      const l = 5 + rnd() * 80
      paths.push(line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, rnd() < 0.1 ? 2 : 0.5))
    }
    const raw = page(paths, [text('OFFICE 1', 100, 100)])
    const t0 = performance.now()
    const ctx = inferContext(raw)
    const dt = performance.now() - t0
    console.log(`perf: ${dt.toFixed(0)} ms, items=${ctx.items.length}`)
    expect(dt).toBeLessThan(1000)
  })
})
