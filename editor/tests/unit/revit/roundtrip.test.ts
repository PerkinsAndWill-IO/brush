import { describe, expect, it } from 'vitest'
import { formatSeconds, RoundTrips, tripMs, tripStats } from '../../../src/app/revit/roundtrip'
import type { SyncEntry } from '../../../src/app/revit/sync'

const entry = (id: string, status: SyncEntry['status'], landed = false): SyncEntry => ({ id, sheetId: 's', status, landed })

describe('RoundTrips: the round-trip timer', () => {
  it('times a command from pen-up through sent and applied to landing back on the sheet', () => {
    const r = new RoundTrips()
    r.begin('c1', 's', 'create_wall', 1000, 1400)
    r.observe([entry('c1', 'sending')], 1700)
    r.observe([entry('c1', 'applied')], 3000)
    r.observe([entry('c1', 'applied', true)], 4500)
    const [t] = r.trips()
    expect(t).toMatchObject({ start: 1000, committed: 1400, sent: 1700, applied: 3000, landed: 4500 })
    expect(tripMs(t, 99999)).toBe(3500)
  })

  it('stamps a phase once: later observations do not move it', () => {
    const r = new RoundTrips()
    r.begin('c1', 's', 'create_wall', 0, 0)
    r.observe([entry('c1', 'applied')], 100)
    r.observe([entry('c1', 'applied')], 200)
    expect(r.trips()[0]).toMatchObject({ sent: 100, applied: 100 })
    expect(r.trips()[0].landed).toBeUndefined()
  })

  it('a trip on its way counts up to now; a failed one stops; a skipped one is not a trip', () => {
    const r = new RoundTrips()
    r.begin('a', 's', 'create_wall', 0, 0)
    r.begin('b', 's', 'place_door', 0, 0)
    r.begin('c', 's', 'place_door', 0, 0)
    r.observe([entry('b', 'failed'), entry('c', 'skipped')], 50)
    expect(tripMs(r.trips()[0], 700)).toBe(700)
    expect(r.trips().map((t) => [t.id, !!t.failed])).toEqual([
      ['a', false],
      ['b', true],
    ])
  })

  it('begins a command once, and forgets it when undone', () => {
    const r = new RoundTrips()
    expect(r.begin('a', 's', 'create_wall', 0, 0)).toBe(true)
    expect(r.begin('a', 's', 'create_wall', 5, 5)).toBe(false)
    r.forget('a')
    expect(r.trips()).toEqual([])
  })

  it('stats: last, best and median of the trips that landed', () => {
    const r = new RoundTrips()
    for (const [id, ms] of [['a', 3000], ['b', 1800], ['c', 2400]] as const) {
      r.begin(id, 's', 'create_wall', 0, 0)
      r.observe([entry(id, 'applied', true)], ms)
    }
    r.begin('d', 's', 'create_wall', 0, 0)
    expect(tripStats(r.trips())).toEqual({ count: 3, last: 2400, best: 1800, median: 2400 })
    expect(formatSeconds(2440)).toBe('2.4 s')
  })
})
