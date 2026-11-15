/**
 * Round-trip timer: how long a sketched element takes to come back from Revit as a modelled one.
 *
 * One trip per command on a linked sheet, timed from the pen lifting off the stroke that made it to the sheet coming
 * back from Revit with it drawn in. On the way it records when the editor committed the reading, when the apply was
 * sent, and when Revit answered. The controller feeds it; the timer pill and the per-ink chips read it.
 *
 * Shown when turned on (the Revit panel's switch, or `?timer` in the URL); remembered per browser.
 */
import { useSyncExternalStore } from 'react'
import type { SyncEntry } from './sync'

export type TripPhase = 'committed' | 'sent' | 'applied' | 'landed'

export interface Trip {
  id: string
  sheetId: string
  op: string
  /** Pen up on the stroke (performance.now()). */
  start: number
  committed?: number
  sent?: number
  applied?: number
  landed?: number
  failed?: boolean
}

export interface RoundTripState {
  enabled: boolean
  /** Newest last. Only trips of the current session; capped. */
  trips: readonly Trip[]
}

const KEY = 'brush.revit.timer'
const KEEP = 40

function readEnabled(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('timer')) return true
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

/** Seconds with one decimal under a minute: 2.4 s. */
export function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`
}

/** The tracker, kept free of the DOM so it can be tested on its own. */
export class RoundTrips {
  private byId = new Map<string, Trip>()
  private order: string[] = []

  /** A command appeared on a linked sheet. `start` is when its stroke's pen lifted (or now, when unknown). */
  begin(id: string, sheetId: string, op: string, start: number, now: number): boolean {
    if (this.byId.has(id)) return false
    this.byId.set(id, { id, sheetId, op, start: Math.min(start, now), committed: now })
    this.order.push(id)
    while (this.order.length > KEEP) this.byId.delete(this.order.shift()!)
    return true
  }

  /** Read the sync entries and stamp each phase the first time it is reached. Returns true when anything changed. */
  observe(entries: readonly SyncEntry[], now: number): boolean {
    let changed = false
    for (const e of entries) {
      const t = this.byId.get(e.id)
      if (!t || t.landed !== undefined || t.failed) continue
      if (e.status === 'failed') {
        t.failed = true
        changed = true
        continue
      }
      if (e.status === 'skipped') {
        // the model already had it: no new sheet comes for it; it does not count as a trip
        this.forget(e.id)
        changed = true
        continue
      }
      const stamp = (phase: 'sent' | 'applied' | 'landed') => {
        if (t[phase] !== undefined) return
        t[phase] = now
        changed = true
      }
      if (e.status === 'sending' || e.status === 'applied') stamp('sent')
      if (e.status === 'applied') stamp('applied')
      if (e.status === 'applied' && e.landed) stamp('landed')
    }
    return changed
  }

  /** Undone before it went anywhere, or reverted. */
  forget(id: string): void {
    if (!this.byId.delete(id)) return
    this.order = this.order.filter((x) => x !== id)
  }

  clear(): void {
    this.byId.clear()
    this.order = []
  }

  trips(): Trip[] {
    return this.order.map((id) => ({ ...this.byId.get(id)! }))
  }
}

/** A trip's total so far (to landing, or to `now` while it is on its way). */
export const tripMs = (t: Trip, now: number) => (t.landed ?? now) - t.start

/** Summary of the trips that landed: last, best, median. */
export function tripStats(trips: readonly Trip[]): { count: number; last?: number; best?: number; median?: number } {
  const done = trips.filter((t) => t.landed !== undefined).map((t) => t.landed! - t.start)
  if (!done.length) return { count: 0 }
  const sorted = [...done].sort((a, b) => a - b)
  return { count: done.length, last: done[done.length - 1], best: sorted[0], median: sorted[Math.floor(sorted.length / 2)] }
}

// ─────────────── the app's instance ───────────────

const tracker = new RoundTrips()
let state: RoundTripState = { enabled: readEnabled(), trips: [] }
const listeners = new Set<() => void>()
const publish = () => {
  state = { ...state, trips: tracker.trips() }
  listeners.forEach((l) => l())
}

export const roundTrips = {
  begin(id: string, sheetId: string, op: string, start: number) {
    if (tracker.begin(id, sheetId, op, start, performance.now())) publish()
  },
  observe(entries: readonly SyncEntry[]) {
    if (tracker.observe(entries, performance.now())) publish()
  },
  forget(id: string) {
    tracker.forget(id)
    publish()
  },
  clear() {
    tracker.clear()
    publish()
  },
  setEnabled(on: boolean) {
    try {
      localStorage.setItem(KEY, on ? '1' : '0')
    } catch {
      /* private mode: this session only */
    }
    state = { ...state, enabled: on }
    listeners.forEach((l) => l())
  },
  get: (): RoundTripState => state,
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useRoundTrips = (): RoundTripState => useSyncExternalStore(subscribe, roundTrips.get)
