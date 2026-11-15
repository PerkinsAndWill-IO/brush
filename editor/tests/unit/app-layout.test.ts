/**
 * Pure board logic from src/app/board (no DOM): layout, sheet ↔ board ↔ screen
 * transforms, sheet lookup (M1-03, M1-04, M1-05, M1-07), eraser hit-testing (M1-08),
 * undo history (M1-09) and ink outlines (M1-06).
 */
import { describe, expect, it } from 'vitest'
import type { Stroke } from '@core/types'
import { nextCommandId, StrokeHistory } from '../../src/app/board/history'
import { eraserTouches, hasPressure, inkRender, pointsBBox, pressureWidth } from '../../src/app/board/ink'
import {
  boardToSheet,
  fitCamera,
  layoutSheets,
  panBy,
  renderScaleFor,
  detailRegionFor,
  screenToBoard,
  screenToSheet,
  sheetAt,
  sheetToBoard,
  sheetToScreen,
  zoomAt,
} from '../../src/app/board/layout'

const A3 = { w: 1191, h: 842 }
const sheets = Array.from({ length: 6 }, (_, i) => ({ id: `sheet-${i}`, pageIndex: i, sizePt: A3 }))

describe('M1-03: grid layout', () => {
  it('lays 6 sheets out as 3 columns × 2 rows, page order, no overlap', () => {
    const pl = layoutSheets(sheets)
    expect(pl).toHaveLength(6)
    expect(new Set(pl.slice(0, 3).map((p) => p.y)).size).toBe(1)
    expect(pl[3].y).toBeGreaterThan(pl[0].y + A3.h)
    expect(pl[1].x).toBeGreaterThan(pl[0].x + A3.w)
    expect(pl[3].x).toBe(pl[0].x)
    for (let i = 0; i < 6; i++)
      for (let j = i + 1; j < 6; j++) {
        const a = pl[i]
        const b = pl[j]
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
      }
  })
  it('one sheet sits at the origin', () => {
    expect(layoutSheets([sheets[0]])).toEqual([{ sheetId: 'sheet-0', pageIndex: 0, x: 0, y: 0, w: 1191, h: 842 }])
  })
  it('a few oversized sheets do not stretch the grid of normal ones', () => {
    const big = { w: A3.w * 7, h: A3.h * 7 }
    const mixed = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, pageIndex: i, sizePt: i === 5 || i === 6 ? big : A3 }))
    const pl = layoutSheets(mixed)
    const normal = pl.filter((_, i) => i !== 5 && i !== 6)
    // normal sheets keep cells about one sheet wide: neighbors in a row are close, columns line up across rows
    const step = pl[1].x - pl[0].x
    expect(step).toBeLessThan(A3.w * 1.5)
    for (const p of normal) expect(p.x / step).toBeCloseTo(Math.round(p.x / step), 9)
    // the board stays landscape-ish instead of a tall strip of oversized sheets
    const right = Math.max(...pl.map((p) => p.x + p.w))
    const bottom = Math.max(...pl.map((p) => p.y + p.h))
    expect(bottom / right).toBeLessThan(2)
    // each oversized sheet starts its own row, at the left edge
    expect(pl[5].x).toBe(0)
    expect(pl[6].x).toBe(0)
    expect(pl[6].y).toBeGreaterThan(pl[5].y + big.h)
    for (let i = 0; i < pl.length; i++)
      for (let j = i + 1; j < pl.length; j++) {
        const a = pl[i]
        const b = pl[j]
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
      }
  })
})

describe('M1-07: sheet coordinates', () => {
  const pl = layoutSheets(sheets)
  const cam = { x: -120.5, y: 33, z: 0.37 }

  it('sheet → board → sheet round-trips', () => {
    const p = { x: 512.4, y: 266.1 }
    const back = boardToSheet(pl[4], sheetToBoard(pl[4], p))
    expect(back.x).toBeCloseTo(p.x, 9)
    expect(back.y).toBeCloseTo(p.y, 9)
  })

  it('sheet → screen → sheet round-trips at any camera', () => {
    for (const c of [cam, { x: 0, y: 0, z: 1 }, { x: 10, y: -2000, z: 4 }]) {
      const p = { x: 700.25, y: 12.5 }
      const back = screenToSheet(c, pl[2], sheetToScreen(c, pl[2], p))
      expect(back.x).toBeCloseTo(p.x, 9)
      expect(back.y).toBeCloseTo(p.y, 9)
    }
  })

  it('stored points do not depend on zoom: the same screen gesture at two zooms maps to the same sheet point', () => {
    const p = { x: 300, y: 400 }
    const z1 = { x: 0, y: 0, z: 0.5 }
    const z2 = zoomAt(z1, { x: 200, y: 200 }, 3)
    expect(screenToSheet(z2, pl[0], sheetToScreen(z2, pl[0], p)).x).toBeCloseTo(300, 9)
  })

  it('finds the sheet under a board point, null between sheets (ink there is discarded)', () => {
    expect(sheetAt(pl, sheetToBoard(pl[0], { x: 10, y: 10 }))?.sheetId).toBe('sheet-0')
    expect(sheetAt(pl, sheetToBoard(pl[5], { x: 1190, y: 841 }))?.sheetId).toBe('sheet-5')
    expect(sheetAt(pl, { x: pl[0].x + pl[0].w + 5, y: pl[0].y + 10 })).toBeNull()
    expect(sheetAt(pl, { x: -1, y: -1 })).toBeNull()
  })
})

describe('M1-04: camera', () => {
  it('zoomAt keeps the board point under the pointer fixed', () => {
    const cam = { x: -50, y: 20, z: 0.8 }
    const at = { x: 431, y: 277 }
    const before = screenToBoard(cam, at)
    const next = zoomAt(cam, at, 2.5)
    expect(next.z).toBe(2.5)
    const after = screenToBoard(next, at)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })
  it('zoom is clamped', () => {
    expect(zoomAt({ x: 0, y: 0, z: 1 }, { x: 0, y: 0 }, 1000).z).toBe(24)
    expect(zoomAt({ x: 0, y: 0, z: 1 }, { x: 0, y: 0 }, 0).z).toBe(0.05)
  })
  it('panBy moves content by the screen delta', () => {
    const cam = { x: 0, y: 0, z: 2 }
    const p = { x: 100, y: 100 }
    const s0 = { x: (p.x + cam.x) * cam.z, y: (p.y + cam.y) * cam.z }
    const n = panBy(cam, 30, -10)
    expect((p.x + n.x) * n.z - s0.x).toBeCloseTo(30)
    expect((p.y + n.y) * n.z - s0.y).toBeCloseTo(-10)
  })
  it('fitCamera centers the content inside the padded viewport', () => {
    const cam = fitCamera({ x: 0, y: 0, w: 4000, h: 2000 }, 1000, 800, 50)
    expect(cam.z).toBeCloseTo(0.225)
    const c = { x: (2000 + cam.x) * cam.z, y: (1000 + cam.y) * cam.z }
    expect(c.x).toBeCloseTo(500)
    expect(c.y).toBeCloseTo(400)
  })
  it('fitCamera shows the top of a board too tall for the minimum zoom, where the first sheet is', () => {
    // at zoom 0.05 this board is 10 000 px tall in an 800 px viewport; its width (200 px) fits
    const cam = fitCamera({ x: 0, y: 0, w: 4000, h: 200_000 }, 1000, 800, 50)
    expect(cam.z).toBeCloseTo(0.05)
    expect((0 + cam.x) * cam.z).toBeCloseTo(400) // left edge: centered, (1000 - 200) / 2
    expect((0 + cam.y) * cam.z).toBeCloseTo(50) // top edge: at the padding
  })
})

describe('M1-05: render resolution', () => {
  it('is at least zoom × dpr, quantized to powers of two', () => {
    expect(renderScaleFor(0.5, 1, A3)).toBe(0.5)
    expect(renderScaleFor(0.6, 1, A3)).toBe(1)
    expect(renderScaleFor(4, 1, A3)).toBe(4)
    expect(renderScaleFor(1, 2, A3)).toBe(2)
    expect(renderScaleFor(0.1, 1, A3)).toBe(0.5)
  })
  it('is capped by the pixel budget', () => {
    const s = renderScaleFor(8, 2, A3)
    expect(A3.w * A3.h * s * s).toBeLessThanOrEqual(4096 * 4096 + 1)
  })
})

describe('detail raster when zoomed past the page raster budget', () => {
  const pl = { sheetId: 's', pageIndex: 0, x: 0, y: 0, w: A3.w, h: A3.h }
  it('is null while the page raster is sharp enough', () => {
    const cam = { x: 0, y: 0, z: 1 }
    expect(detailRegionFor(cam, 1200, 800, pl, 2, renderScaleFor(1, 2, A3))).toBeNull()
  })
  it('covers the visible part of the sheet at exactly zoom × dpr, inside the pixel budget', () => {
    // zoomed to 8× on the sheet centre
    const cam = { x: 1200 / 2 / 8 - A3.w / 2, y: 800 / 2 / 8 - A3.h / 2, z: 8 }
    const base = renderScaleFor(8, 2, A3)
    const d = detailRegionFor(cam, 1200, 800, pl, 2, base)!
    expect(d.scale).toBe(16)
    const vis = { x: -cam.x, y: -cam.y, w: 1200 / 8, h: 800 / 8 }
    expect(d.rect.x).toBeLessThanOrEqual(vis.x)
    expect(d.rect.y).toBeLessThanOrEqual(vis.y)
    expect(d.rect.x + d.rect.w).toBeGreaterThanOrEqual(vis.x + vis.w)
    expect(d.rect.y + d.rect.h).toBeGreaterThanOrEqual(vis.y + vis.h)
    expect(d.rect.w * d.rect.h * d.scale * d.scale).toBeLessThanOrEqual(4096 * 4096)
    expect(Number.isInteger(d.rect.x * d.scale)).toBe(true)
  })
  it('stays inside the sheet and is null off screen', () => {
    const cam = { x: 10, y: 10, z: 8 } // sheet's top-left corner near the viewport's top-left
    const d = detailRegionFor(cam, 1200, 800, pl, 2, 2)!
    expect(d.rect.x).toBe(0)
    expect(d.rect.y).toBe(0)
    expect(detailRegionFor({ x: -5000, y: 0, z: 8 }, 1200, 800, pl, 2, 2)).toBeNull()
  })
})

const stroke = (id: string, pts: [number, number][], size = 2): Stroke => ({
  id,
  sheetId: 'sheet-0',
  tool: 'brush',
  size,
  points: pts.map(([x, y], i) => ({ x, y, t: i * 8 })),
})

describe('M1-08: eraser hit-test', () => {
  const s = stroke('a', [
    [100, 100],
    [200, 100],
    [300, 100],
  ])
  const bb = pointsBBox(s.points)
  it('touches when the eraser crosses the stroke', () => {
    expect(eraserTouches(s, bb, { x: 150, y: 50 }, { x: 150, y: 150 }, 2)).toBe(true)
  })
  it('touches within radius + half the stroke width', () => {
    expect(eraserTouches(s, bb, { x: 150, y: 105 }, { x: 250, y: 105 }, 4.5)).toBe(true)
    expect(eraserTouches(s, bb, { x: 150, y: 110 }, { x: 250, y: 110 }, 4.5)).toBe(false)
  })
  it('misses far away strokes', () => {
    expect(eraserTouches(s, bb, { x: 500, y: 500 }, { x: 600, y: 600 }, 10)).toBe(false)
  })
})

describe('M1-09: undo history', () => {
  it('undoes and redoes adds and erasures, restoring order', () => {
    const h = new StrokeHistory()
    const [a, b, c] = ['a', 'b', 'c'].map((id) => stroke(id, [[0, 0]]))
    h.add(a)
    h.add(b)
    h.add(c)
    const removed = [...h.removeLive(new Set(['b'])), ...h.removeLive(new Set(['a']))]
    h.commitErase(removed)
    expect(h.strokes().map((s) => s.id)).toEqual(['c'])
    h.undo()
    expect(h.strokes().map((s) => s.id)).toEqual(['a', 'b', 'c'])
    h.redo()
    expect(h.strokes().map((s) => s.id)).toEqual(['c'])
    h.undo()
    h.undo()
    expect(h.strokes().map((s) => s.id)).toEqual(['a', 'b'])
    expect(h.canRedo()).toBe(true)
    h.add(stroke('d', [[1, 1]]))
    expect(h.canRedo()).toBe(false)
  })
})

describe('M1-06: ink rendering', () => {
  it('constant width draws a stroked centerline with the brush size', () => {
    const r = inkRender(stroke('a', [[0, 0], [10, 0], [20, 5]], 4).points, 4, 0.5)
    expect(r.mode).toBe('stroke')
    expect(r.width).toBe(4)
    expect(r.d.startsWith('M0 0')).toBe(true)
  })
  it('pressure draws a filled outline whose width follows pressure', () => {
    const pts = [
      { x: 0, y: 0, t: 0, p: 0.1 },
      { x: 10, y: 0, t: 8, p: 0.5 },
      { x: 20, y: 0, t: 16, p: 0.9 },
    ]
    expect(hasPressure(pts)).toBe(true)
    const r = inkRender(pts, 4, 0)
    expect(r.mode).toBe('fill')
    expect(r.d.endsWith('Z')).toBe(true)
    expect(pressureWidth(4, 0.5)).toBeCloseTo(4)
    expect(pressureWidth(4, 0.9)).toBeGreaterThan(pressureWidth(4, 0.1))
  })
  it('a single point still renders a dot', () => {
    expect(inkRender([{ x: 5, y: 5, t: 0 }], 3, 0.5).d).toMatch(/^M5 5L/)
  })
})

describe('M3: commits in the undo history', () => {
  it('a commit adds an accepted decision and a command; undo removes them and keeps the ink; erase takes them along', () => {
    const h = new StrokeHistory()
    const s = stroke('a', [[0, 0], [100, 0]])
    h.add(s)
    const d = { strokeId: 'a', sheetId: 'sheet-0', kind: 'wall' as const, geometry: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false }, confidence: 0.8, committedAt: 1 }
    const c = { op: 'create_wall' as const, id: nextCommandId([]), sheetId: 'sheet-0', path: d.geometry, strokeId: 'a' }
    expect(c.id).toBe('cmd-0001')
    h.commit(d, c)
    expect(h.accepted()).toHaveLength(1)
    expect(h.commands()).toHaveLength(1)
    expect(nextCommandId(h.commands())).toBe('cmd-0002')
    h.undo()
    expect(h.accepted()).toHaveLength(0)
    expect(h.commands()).toHaveLength(0)
    expect(h.strokes()).toHaveLength(1)
    h.redo()
    h.erase(new Set(['a']))
    expect([h.strokes().length, h.accepted().length, h.commands().length]).toEqual([0, 0, 0])
    h.undo()
    expect([h.strokes().length, h.accepted().length, h.commands().length]).toEqual([1, 1, 1])
  })
})
