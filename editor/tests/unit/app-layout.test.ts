/**
 * Pure board logic from src/app/board (no DOM): layout, sheet ↔ board ↔ screen
 * transforms, sheet lookup (M1-03, M1-04, M1-05, M1-07), eraser hit-testing (M1-08),
 * undo history (M1-09) and ink outlines (M1-06).
 */
import { describe, expect, it } from 'vitest'
import type { Stroke } from '@core/types'
import { StrokeHistory } from '../../src/app/board/history'
import { eraserTouches, hasPressure, inkRender, pointsBBox, pressureWidth } from '../../src/app/board/ink'
import {
  boardToSheet,
  fitCamera,
  layoutSheets,
  panBy,
  renderScaleFor,
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
    expect(zoomAt({ x: 0, y: 0, z: 1 }, { x: 0, y: 0 }, 1000).z).toBe(8)
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
