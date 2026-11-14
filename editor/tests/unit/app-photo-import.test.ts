/**
 * P1 (photo import), the parts that need no pixels: traced markup -> session strokes (P1-04), an import as one
 * undo step (P1-05), and the choice of sheet and working resolution (P1-02).
 */
import { describe, expect, it } from 'vitest'
import type { Sheet, Stroke } from '@core/types'
import { StrokeHistory } from '../../src/app/board/history'
import { inkRender } from '../../src/app/board/ink'
import { MAX_AUTO_SHEETS, MAX_WORK_SIDE, MIN_INLIERS, candidateSheets, knownSheetId, pickSheet, sheetLabel, workingDpi } from '../../src/app/photo/plan'
import { markupToStrokes, resampleCentreline, rgbToHex } from '../../src/app/photo/toStrokes'
import type { MarkupLayer } from '../../src/app/photo/pipeline'

const A3 = { w: 1191, h: 842 }
const sheets: Sheet[] = Array.from({ length: 6 }, (_, i) => ({ id: `sheet-${i}`, number: `A-${i + 1}01`, name: `LEVEL ${i + 1}`, pageIndex: i, sizePt: A3 }))

describe('P1-04: traced markup becomes brush strokes', () => {
  const layers: MarkupLayer[] = [
    {
      name: 'red',
      color: [197.4, 0, 11],
      strokes: [
        { points: [[100, 100], [130, 100], [130, 140]], width: 2.37, closed: false },
        { points: [[300, 300]], width: 3, closed: false }, // a dot
      ],
    },
    { name: 'blue', color: [0, 51, 161], strokes: [{ points: [[10, 10], [50, 10], [50, 50], [10, 50]], width: 0.2, closed: true, outline: true }] },
  ]
  const strokes = markupToStrokes(layers, { sheetId: 'sheet-2', idPrefix: 'p-', startedAt: 1700000000000 })

  it('makes one brush stroke per traced stroke, on the sheet, in the ink colour and pen width', () => {
    expect(strokes.map((s) => s.id)).toEqual(['p-0', 'p-1', 'p-2'])
    expect(new Set(strokes.map((s) => s.sheetId))).toEqual(new Set(['sheet-2']))
    expect(strokes.every((s) => s.tool === 'brush' && s.startedAt === 1700000000000)).toBe(true)
    expect(strokes.map((s) => s.color)).toEqual(['#c5000b', '#c5000b', '#0033a1'])
    expect(strokes[0].size).toBe(2.37)
    expect(strokes[2].size).toBe(0.5) // never thinner than half a point
  })

  it('resamples the centreline evenly, keeping every vertex, with rising timestamps', () => {
    const pts = strokes[0].points
    expect(pts[0]).toMatchObject({ x: 100, y: 100, t: 0 })
    expect(pts[pts.length - 1]).toMatchObject({ x: 130, y: 140 })
    expect(pts.some((p) => p.x === 130 && p.y === 100)).toBe(true)
    for (let i = 1; i < pts.length; i++) {
      expect(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)).toBeLessThanOrEqual(2.01)
      expect(pts[i].t).toBeGreaterThanOrEqual(pts[i - 1].t)
    }
    // 70 pt at 0.5 pt/ms
    expect(pts[pts.length - 1].t).toBe(140)
    expect(pts.every((p) => p.p === undefined)).toBe(true)
  })

  it('closes a closed stroke by returning to its first point; a dot stays one sample', () => {
    const loop = strokes[2].points
    expect(loop[loop.length - 1]).toMatchObject({ x: 10, y: 10 })
    expect(strokes[1].points).toEqual([{ x: 300, y: 300, t: 0 }])
    expect(resampleCentreline([[0, 0], [10, 0]], true, 2, 0.5)).toHaveLength(6) // two points cannot close
  })

  it('renders through the board ink path like a drawn stroke', () => {
    for (const s of strokes) {
      const r = inkRender(s.points, s.size, 0.5)
      expect(r.mode).toBe('stroke')
      expect(r.d.startsWith('M')).toBe(true)
    }
  })

  it('formats ink colours as CSS hex', () => {
    expect(rgbToHex([255, 0, 128])).toBe('#ff0080')
    expect(rgbToHex([300, -4, 9.6])).toBe('#ff000a')
  })
})

describe('P1-05: an import is one undo step', () => {
  const stroke = (id: string): Stroke => ({ id, sheetId: 'sheet-0', points: [{ x: 0, y: 0, t: 0 }], tool: 'brush', size: 2 })

  it('addMany adds every stroke; undo removes them all, redo brings them back', () => {
    const h = new StrokeHistory([stroke('a')])
    h.add(stroke('b'))
    h.addMany([stroke('p0'), stroke('p1'), stroke('p2')])
    expect(h.strokes().map((s) => s.id)).toEqual(['a', 'b', 'p0', 'p1', 'p2'])
    expect(h.undo()).toBe(true)
    expect(h.strokes().map((s) => s.id)).toEqual(['a', 'b'])
    expect(h.canRedo()).toBe(true)
    expect(h.redo()).toBe(true)
    expect(h.strokes().map((s) => s.id)).toEqual(['a', 'b', 'p0', 'p1', 'p2'])
    h.undo()
    h.undo()
    expect(h.strokes().map((s) => s.id)).toEqual(['a'])
  })

  it('imported strokes erase and come back like any other', () => {
    const h = new StrokeHistory()
    h.addMany([stroke('p0'), stroke('p1')])
    h.erase(new Set(['p0']))
    expect(h.strokes().map((s) => s.id)).toEqual(['p1'])
    h.undo()
    expect(h.strokes().map((s) => s.id)).toEqual(['p0', 'p1'])
  })

  it('an empty import records nothing', () => {
    const h = new StrokeHistory()
    h.addMany([])
    expect(h.canUndo()).toBe(false)
  })
})

describe('P1-02: which sheets to try, and at what resolution', () => {
  it('tries the named sheet only', () => {
    expect(candidateSheets(sheets, 'sheet-3', 'sheet-1').map((s) => s.id)).toEqual(['sheet-3'])
    expect(candidateSheets(sheets, 'gone', null)).toEqual([])
  })

  it('otherwise tries the active sheet first, then the rest in order, up to the cap', () => {
    expect(candidateSheets(sheets, undefined, 'sheet-4').map((s) => s.id)).toEqual(['sheet-4', 'sheet-0', 'sheet-1', 'sheet-2', 'sheet-3', 'sheet-5'])
    expect(candidateSheets(sheets, undefined, null).map((s) => s.id)).toEqual(sheets.map((s) => s.id))
    const many: Sheet[] = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, pageIndex: i, sizePt: A3 }))
    expect(candidateSheets(many, undefined, 's30')).toHaveLength(MAX_AUTO_SHEETS)
    expect(candidateSheets(many, undefined, 's30')[0].id).toBe('s30')
  })

  it('picks the sheet with the most matches, however well an earlier look-alike matched', () => {
    const probes = [
      { sheet: sheets[0], probe: { inliers: 180, seenDpi: 70 } }, // same title block and grid: a strong match too
      { sheet: sheets[1], probe: null },
      { sheet: sheets[2], probe: { inliers: 420, seenDpi: 72 } }, // the sheet in the photo
      { sheet: sheets[3], probe: { inliers: 175, seenDpi: 70 } },
    ]
    expect(pickSheet(probes)?.sheet.id).toBe('sheet-2')
    expect(pickSheet(probes)?.probe.seenDpi).toBe(72)
  })

  it('refuses when no sheet reaches the bar, and breaks a tie towards the earlier candidate', () => {
    expect(pickSheet([{ sheet: sheets[0], probe: { inliers: MIN_INLIERS - 1 } }, { sheet: sheets[1], probe: null }])).toBeNull()
    expect(pickSheet([])).toBeNull()
    expect(pickSheet([{ sheet: sheets[4], probe: { inliers: 50 } }, { sheet: sheets[1], probe: { inliers: 50 } }])?.sheet.id).toBe('sheet-4')
    expect(pickSheet([{ sheet: sheets[0], probe: { inliers: MIN_INLIERS } }])?.sheet.id).toBe('sheet-0')
  })

  it('a remembered sheet choice only counts if that sheet is in the open document', () => {
    expect(knownSheetId(sheets, 'sheet-3')).toBe('sheet-3')
    expect(knownSheetId(sheets, '382617')).toBeUndefined() // chosen in another document
    expect(knownSheetId(sheets, '')).toBeUndefined()
    expect(knownSheetId(sheets, undefined)).toBeUndefined()
    expect(knownSheetId([], 'sheet-0')).toBeUndefined()
  })

  it('works at about twice the resolution the photo has on the sheet, within 36..150 dpi', () => {
    expect(workingDpi(47.6, A3)).toBe(96)
    expect(workingDpi(10, A3)).toBe(36)
    expect(workingDpi(400, A3)).toBe(150)
  })

  it('caps the working raster on large sheets', () => {
    const A0 = { w: 3370, h: 2384 }
    const dpi = workingDpi(120, A0)
    expect((A0.w / 72) * dpi).toBeLessThanOrEqual(MAX_WORK_SIDE)
    expect(dpi).toBeGreaterThan(95)
  })

  it('labels a sheet by number and name', () => {
    expect(sheetLabel(sheets[0])).toBe('A-101 LEVEL 1')
    expect(sheetLabel({ id: 'v', name: '{3D}', pageIndex: 0, sizePt: A3 })).toBe('{3D}')
  })
})
