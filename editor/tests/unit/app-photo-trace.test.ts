/**
 * P1-12 (trace paper over the sheet after an import) and P1-13 (the import's progress, told in stages):
 * app/photo/trace.ts and progress.ts (docs/tasks/P1-photo-import.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAGES, advanceStage, clock, patter, progressFraction, sheetOfLine, stageOfLine } from '../../src/app/photo/progress'
import { ROLL_UP_MS, UNROLL_MS, tracePaper } from '../../src/app/photo/trace'

describe('P1-13 progress stages', () => {
  // the lines an import actually logs, in order (the KRO photo)
  const LOG = [
    'Reading the photo…',
    'Photo 2000 × 1500 px',
    'Looking for the sheet: KRO-APD-ARC-PLN-A1A-N01-0001-007 PLAN GENERAL · LOT A1A · PLAN N01…',
    'Looking for the sheet: A-201 Level 2…',
    'KRO-APD-ARC-PLN-A1A-N01-0001-007 PLAN GENERAL · LOT A1A · PLAN N01: the photo resolves about 30 dpi on the sheet; tracing at 60 dpi…',
    'features (threshold 0.001): photo 7181, drawing 7836, matches 751, inliers 450 / 94 / 36',
    'homography refit 1: 697/1120 tiles locked, median offset 4.78 px, p95 9.19 px (sheet px)',
    'wrinkle correction pass 1: median offset 0.25 px, p95 2.66 px, 646 tiles pinned both ways + 146 one way, of 1148',
    'separating the ink from the print…',
    'ink found: black 14173 px',
    'layer black: rgb(28,0,17), 43 strokes (median width 2.3 mm on the sheet)',
  ]

  it('P1-13 reads the stage off the import lines, forward only', () => {
    const seen = LOG.reduce<string[]>((acc, l) => [...acc, advanceStage((acc.at(-1) ?? 'develop') as never, l)], [])
    expect(seen).toEqual(['develop', 'develop', 'find', 'find', 'align', 'align', 'align', 'align', 'trace', 'trace', 'trace'])
    // a late line of an earlier stage does not take it back
    expect(advanceStage('trace', 'Looking for the sheet: A-101…')).toBe('trace')
    expect(stageOfLine('  tiles not used: {}')).toBeUndefined()
  })

  it('P1-13 names the sheet being compared, short', () => {
    expect(sheetOfLine('Looking for the sheet: A-201 Level 2…')).toBe('A-201 Level 2')
    expect(sheetOfLine(LOG[2])).toBe('KRO-APD-ARC-PLN-A1A-N01-0001-007')
    expect(sheetOfLine('Photo 2000 × 1500 px')).toBeUndefined()
    expect(patter('find', 0, 'A-201')).toContain('A-201')
    expect(patter('find', 100)).not.toContain('{sheet}')
  })

  it('P1-13 progress only grows, never reaches the end before the import does', () => {
    let last = -1
    for (const s of STAGES)
      for (const t of [0, 1, 5, 30, 600]) {
        const f = progressFraction(s, t)
        expect(f).toBeGreaterThanOrEqual(last)
        expect(f).toBeLessThan(1)
        last = f
      }
    expect(clock(65)).toBe('1:05')
  })
})

describe('P1-12 trace paper', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    tracePaper.clear()
    vi.useRealTimers()
  })

  it('P1-12 unrolls, settles, rolls up and goes', () => {
    tracePaper.unroll('sheet-0')
    expect(tracePaper.get('sheet-0')?.phase).toBe('unrolling')
    vi.advanceTimersByTime(UNROLL_MS)
    expect(tracePaper.get('sheet-0')?.phase).toBe('shown')
    tracePaper.rollUp('sheet-0')
    expect(tracePaper.get('sheet-0')?.phase).toBe('rolling')
    vi.advanceTimersByTime(ROLL_UP_MS)
    expect(tracePaper.get('sheet-0')).toBeUndefined()
  })

  it('P1-12 unrolling again while it rolls up brings it back', () => {
    tracePaper.unroll('sheet-0')
    vi.advanceTimersByTime(UNROLL_MS)
    tracePaper.rollUp('sheet-0')
    vi.advanceTimersByTime(ROLL_UP_MS / 2)
    tracePaper.unroll('sheet-0')
    vi.advanceTimersByTime(ROLL_UP_MS)
    // the old roll-up's timer does not take it away
    expect(tracePaper.get('sheet-0')?.phase).toBe('unrolling')
    vi.advanceTimersByTime(UNROLL_MS)
    expect(tracePaper.get('sheet-0')?.phase).toBe('shown')
  })

  it('P1-12 opacity is clamped to 0..1', () => {
    tracePaper.setOpacity(1.4)
    expect(tracePaper.opacity()).toBe(1)
    tracePaper.setOpacity(-1)
    expect(tracePaper.opacity()).toBe(0)
    tracePaper.setOpacity(0.35)
    expect(tracePaper.opacity()).toBe(0.35)
  })
})
