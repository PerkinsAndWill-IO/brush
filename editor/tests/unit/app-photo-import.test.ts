/**
 * P1 (photo import), the parts that need no pixels: traced markup -> session strokes (P1-04), an import as one
 * undo step (P1-05), and the choice of sheet and working resolution (P1-02).
 */
import { describe, expect, it } from 'vitest'
import type { Sheet, Stroke } from '@core/types'
import { StrokeHistory } from '../../src/app/board/history'
import { inkRender } from '../../src/app/board/ink'
import { MAX_AUTO_SHEETS, MAX_WORK_SIDE, MIN_TILES, candidateSheets, knownSheetId, matchPrintedSheet, pickSheet, printedScale, sheetLabel, workingDpi } from '../../src/app/photo/plan'
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

  it('picks the sheet that locks onto the photo in the most tiles, however well an earlier look-alike matched', () => {
    const probes = [
      { sheet: sheets[0], probe: { tiles: 180, seenDpi: 70 } }, // same title block and grid: a strong match too
      { sheet: sheets[1], probe: null },
      { sheet: sheets[2], probe: { tiles: 420, seenDpi: 72 } }, // the sheet in the photo
      { sheet: sheets[3], probe: { tiles: 175, seenDpi: 70 } },
    ]
    expect(pickSheet(probes)?.sheet.id).toBe('sheet-2')
    expect(pickSheet(probes)?.probe.seenDpi).toBe(72)
  })

  it('refuses when no sheet reaches the bar, and breaks a tie towards the earlier candidate', () => {
    expect(pickSheet([{ sheet: sheets[0], probe: { tiles: MIN_TILES - 1 } }, { sheet: sheets[1], probe: null }])).toBeNull()
    expect(pickSheet([])).toBeNull()
    expect(pickSheet([{ sheet: sheets[4], probe: { tiles: 50 } }, { sheet: sheets[1], probe: { tiles: 50 } }])?.sheet.id).toBe('sheet-4')
    expect(pickSheet([{ sheet: sheets[0], probe: { tiles: MIN_TILES } }])?.sheet.id).toBe('sheet-0')
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

describe('P1-09: the photo matched to the printed file, the strokes on the open sheet', () => {
  // the KRO case: the open .drawing names its sheets "0001" / "KRO-...-0001", the printed PDF "KRO-...-0001-007"
  const KRO = { w: 3370, h: 2384 }
  const drawing: Sheet[] = [
    { id: '7213266', number: '0001', name: 'KRO-APD-ARC-PLN-A1A-N01-0001', pageIndex: 0, sizePt: KRO },
    { id: '7674853', number: '0032', name: 'KRO-APD-ARC-ELE-A1A-TTN-0032', pageIndex: 1, sizePt: KRO },
    { id: '17307526', number: '0061', name: 'KRO-APD-ARC-SYN-A1A-TTN-0061', pageIndex: 2, sizePt: KRO },
  ]
  const pdfPage = (i: number, number: string, name: string): Sheet => ({ id: `sheet-${i}`, number, name, pageIndex: i, sizePt: { w: 3371, h: 2384 } })

  it('P1-09: finds the open sheet by the number or name in the printed page title, wherever the page is', () => {
    expect(matchPrintedSheet(pdfPage(4, 'KRO-APD-ARC-ELE-A1A-TTN-0032-005', 'ÉLÉVATION GÉNÉRAL · LOT A1A'), 9, drawing)?.id).toBe('7674853')
    expect(matchPrintedSheet(pdfPage(0, 'KRO-APD-ARC-PLN-A1A-N01-0001-007', 'PLAN GENERAL · LOT A1A · PLAN N01'), 3, drawing)?.id).toBe('7213266')
  })

  it('P1-09: the sheet chosen in the dialog wins; same page position when the titles say nothing; else none', () => {
    const page = pdfPage(2, 'X-9', 'Untitled')
    expect(matchPrintedSheet(page, 3, drawing, '7674853')?.id).toBe('7674853')
    expect(matchPrintedSheet(page, 3, drawing)?.id).toBe('17307526') // both files have three pages
    expect(matchPrintedSheet(page, 5, drawing)).toBeNull()
    expect(matchPrintedSheet(page, 5, drawing.slice(0, 1))?.id).toBe('7213266') // the only sheet
  })

  it('P1-09: a title that fits two sheets equally settles nothing', () => {
    const twins: Sheet[] = [
      { id: 'a', number: 'A-101', name: 'LEVEL 1', pageIndex: 0, sizePt: A3 },
      { id: 'b', number: 'A-102', name: 'LEVEL 1', pageIndex: 1, sizePt: A3 },
    ]
    expect(matchPrintedSheet({ id: 'p', name: 'LEVEL 1', pageIndex: 0, sizePt: A3 }, 4, twins)).toBeNull()
    expect(matchPrintedSheet({ id: 'p', number: 'A-102', name: 'LEVEL 1', pageIndex: 0, sizePt: A3 }, 4, twins)?.id).toBe('b')
  })

  it('P1-09: strokes scale from the printed page to the open sheet; other proportions are refused', () => {
    const s = printedScale({ w: 3371, h: 2384 }, KRO)!
    expect(s.sx).toBeCloseTo(3370 / 3371, 6)
    expect(s.sy).toBe(1)
    expect(printedScale({ w: 842, h: 595 }, { w: 1191, h: 842 })?.sx).toBeCloseTo(1191 / 842, 6) // A4 print of an A3 sheet
    expect(printedScale({ w: 842, h: 595 }, { w: 595, h: 842 })).toBeNull() // portrait vs landscape
  })
})
