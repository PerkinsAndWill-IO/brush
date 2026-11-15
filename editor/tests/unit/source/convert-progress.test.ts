import { describe, expect, it } from 'vitest'
import { ConvertTracker, formatDuration, formatEta, overallFraction, phaseLabel, smoothEta } from '../../../src/app/convertProgress'

/** A clock the test moves by hand, in milliseconds. */
function clock() {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('where the one bar stands', () => {
  it('starts empty and ends full', () => {
    expect(overallFraction('upload', 0, 100)).toBe(0)
    expect(overallFraction('open')).toBeCloseTo(0.99, 10)
  })

  it('moves through a step by what that step has done', () => {
    expect(overallFraction('upload', 50, 100)).toBeCloseTo(0.04, 10)
    expect(overallFraction('parse', 0, 0)).toBeCloseTo(0.1, 10)
    expect(overallFraction('draw', 0, 13)).toBeCloseTo(0.45, 10)
    expect(overallFraction('draw', 13, 13)).toBeCloseTo(0.9, 10)
    expect(overallFraction('download', 1, 2)).toBeCloseTo(0.965, 10)
  })

  it('keeps a step that reports more than its total inside the step', () => {
    expect(overallFraction('draw', 20, 13)).toBeCloseTo(0.9, 10)
  })
})

describe('what the person reads', () => {
  it('names each step', () => {
    expect(phaseLabel('upload')).toBe('Uploading')
    expect(phaseLabel('queue')).toBe('Waiting for the server')
    expect(phaseLabel('parse')).toBe('Reading the model')
    expect(phaseLabel('draw', 4, 13)).toBe('Drawing sheets 4/13')
    expect(phaseLabel('write')).toBe('Writing')
    expect(phaseLabel('download')).toBe('Downloading')
    expect(phaseLabel('open')).toBe('Opening')
  })

  it('writes durations and times left', () => {
    expect(formatDuration(45_000)).toBe('45 s')
    expect(formatDuration(80_000)).toBe('1 min 20 s')
    expect(formatDuration(120_000)).toBe('2 min')
    expect(formatEta(82_000)).toBe('about 1 min 20 s left')
    expect(formatEta(58_000)).toBe('about 1 min left')
    expect(formatEta(3000)).toBe('a few seconds left')
  })
})

describe('the time left', () => {
  it('stays unknown until the step has run for a few seconds', () => {
    const c = clock()
    const t = new ConvertTracker(c.now)
    t.update('draw', 0, 13)
    c.advance(2000)
    t.update('draw', 1, 13)
    expect(t.snapshot().etaMs).toBeUndefined()
  })

  it('is the pace of the drawing times the sheets left', () => {
    const c = clock()
    const t = new ConvertTracker(c.now)
    t.update('draw', 0, 10)
    c.advance(5000)
    t.update('draw', 5, 10) // 1 s a sheet, 5 sheets left
    expect(t.snapshot().etaMs).toBe(5000)
  })

  it('is not given for steps whose pace says nothing about the rest', () => {
    const c = clock()
    const t = new ConvertTracker(c.now)
    t.update('upload', 10, 100)
    c.advance(10_000)
    expect(t.snapshot().etaMs).toBeUndefined()
  })

  it('counts down between updates instead of jumping to each new estimate', () => {
    const first = smoothEta(undefined, 40_000, 0)
    expect(first).toEqual({ valueMs: 40_000, at: 0 })
    // 10 s later the old estimate stands at 30 s; a new raw 50 s pulls it only a fifth of the way
    expect(smoothEta(first, 50_000, 10_000)).toEqual({ valueMs: 34_000, at: 10_000 })
    // an estimate that ran out takes the new one whole
    expect(smoothEta(first, 7000, 45_000)).toEqual({ valueMs: 7000, at: 45_000 })
  })
})

describe('a conversion followed from start to end', () => {
  it('shows each step in order, with the bar never going back', () => {
    const c = clock()
    const t = new ConvertTracker(c.now)
    t.update('upload', 50, 100)
    expect(t.snapshot()).toMatchObject({ phase: 'upload', label: 'Uploading', elapsedMs: 0 })
    expect(t.snapshot().fraction).toBeCloseTo(0.04, 10)
    c.advance(1000)
    t.update('queue')
    expect(t.snapshot()).toMatchObject({ label: 'Waiting for the server', elapsedMs: 1000 })
    expect(t.snapshot().fraction).toBeCloseTo(0.08, 10)
    c.advance(1000)
    t.update('draw', 3, 13)
    expect(t.snapshot().label).toBe('Drawing sheets 3/13')
    const high = t.snapshot().fraction!
    t.update('draw', 2, 13) // a late, out-of-order report
    expect(t.snapshot().fraction).toBe(high)
  })

  it('has no position when the server reports nothing, only the time passed', () => {
    const c = clock()
    const t = new ConvertTracker(c.now)
    t.update('upload', 100, 100)
    t.update('queue')
    c.advance(2000)
    t.setOpaque()
    t.update('convert')
    c.advance(30_000)
    expect(t.snapshot()).toEqual({ phase: 'convert', label: 'Converting (this server reports no progress)', fraction: null, elapsedMs: 32_000, etaMs: undefined })
  })
})
