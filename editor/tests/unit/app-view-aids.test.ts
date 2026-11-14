/**
 * Pure view-aid logic from src/app/board/viewAids.ts (docs/tasks/V1-view-aids.md):
 * scale bar (V1-01), real-unit measurement (V1-02), metric grid spacing (V1-03).
 */
import { describe, expect, it } from 'vitest'
import { ptPerMetre } from '@core/context'
import { formatMetres, gridLines, gridSpacingFor, scaleBarFor, sheetDistanceMetres } from '../../src/app/board/viewAids'

describe('V1-01 scale bar', () => {
  it('V1-01: picks the longest 1-2-5 length that fits, in screen px = metres × pt/m × zoom', () => {
    // 1:100 → 28.35 pt per metre; at z = 1, 5 m = 141.7 px fits in 160, 10 m does not
    const bar = scaleBarFor(1, 100)!
    expect(bar.metres).toBe(5)
    expect(bar.px).toBeCloseTo(5 * ptPerMetre(100), 6)
    expect(bar.labels).toEqual(['0', '2.5', '5 m'])
  })
  it('V1-01: follows the zoom and switches to mm for short lengths', () => {
    expect(scaleBarFor(4, 100)!.metres).toBe(1)
    const fine = scaleBarFor(8, 100)!
    expect(fine.metres).toBe(0.5)
    expect(fine.labels).toEqual(['0', '250', '500 mm'])
    expect(scaleBarFor(0.25, 100)!.metres).toBe(20)
  })
  it('V1-01: no bar without a known scale', () => {
    expect(scaleBarFor(1, undefined)).toBeNull()
    expect(scaleBarFor(1, 0)).toBeNull()
  })
})

describe('V1-02 measurement', () => {
  it('V1-02: sheet distance in metres uses the sheet scale', () => {
    const pt = ptPerMetre(50) * 3.6 // 3.6 m at 1:50
    expect(sheetDistanceMetres({ x: 10, y: 10 }, { x: 10 + pt, y: 10 }, 50)).toBeCloseTo(3.6, 9)
    // 1 inch at 1:100 = 2.54 m
    expect(sheetDistanceMetres({ x: 0, y: 0 }, { x: 0, y: 72 }, 100)).toBeCloseTo(2.54, 9)
  })
  it('V1-02: formats mm below 1 m, 2 decimals below 10 m, 1 above', () => {
    expect(formatMetres(0.9)).toBe('900 mm')
    expect(formatMetres(2.544)).toBe('2.54 m')
    expect(formatMetres(12.34)).toBe('12.3 m')
  })
})

describe('V1-03 metric grid', () => {
  it('V1-03: 1 m minors and 5 m majors when 1 m is at least 10 px on screen', () => {
    const g = gridSpacingFor(1, 100, 1190)! // 1 m = 28 px
    expect(g.minorM).toBe(0.5)
    expect(g.majorM).toBe(2.5)
    const g2 = gridSpacingFor(0.4, 100, 1190)! // 1 m = 11 px
    expect(g2.minorM).toBe(1)
    expect(g2.majorM).toBe(5)
    expect(g2.minorPt).toBeCloseTo(ptPerMetre(100), 6)
  })
  it('V1-03: coarsens when zoomed out so lines never crowd', () => {
    const g = gridSpacingFor(0.05, 100, 1190)!
    expect(g.minorPt * 0.05).toBeGreaterThanOrEqual(10)
    expect(gridSpacingFor(1, undefined, 1190)).toBeNull()
  })
  it('V1-03: grid line offsets cover the sheet from 0', () => {
    expect(gridLines(10, 2.5)).toEqual([0, 2.5, 5, 7.5, 10])
    expect(gridLines(10, 0)).toEqual([])
  })
})
