/**
 * Progress of a Revit model becoming a `.drawing` (pure: no DOM, no network; the clock is injected).
 *
 * One bar covers every step the person waits through. Each step owns a share of the bar (`WEIGHT`); the server
 * reports `done` of `total` inside the steps it runs (parse, draw). The time left in the step in progress is extrapolated
 * from its pace, smoothed so the number does not jump between updates.
 */

export type ConvertPhase = 'upload' | 'queue' | 'parse' | 'draw' | 'write' | 'download' | 'open' | 'convert'

/** Share of the bar per step, in the order the person sees them. They add up to 1. `convert` is the one opaque wait of a server that reports nothing. */
const ORDER: ConvertPhase[] = ['upload', 'queue', 'parse', 'draw', 'write', 'download', 'open']
const WEIGHT: Record<ConvertPhase, number> = { upload: 0.08, queue: 0.02, parse: 0.35, draw: 0.45, write: 0.04, download: 0.05, open: 0.01, convert: 0 }

/** The time left is only shown once the step in progress has run this long: before that its pace is a guess. */
export const MIN_ETA_SAMPLE_MS = 3000

/** The share of the previous estimate (aged by the time that passed) kept when a new one arrives. */
const KEEP_PREVIOUS = 0.8

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Progress inside one step, 0 to 1 (0 when the step reports no total). */
export function phaseFraction(done: number, total: number): number {
  return total > 0 ? clamp01(done / total) : 0
}

/** Where the whole bar stands, 0 to 1, with `done` of `total` inside `phase`. */
export function overallFraction(phase: ConvertPhase, done = 0, total = 0): number {
  const at = ORDER.indexOf(phase)
  if (at < 0) return 0
  let before = 0
  for (let i = 0; i < at; i++) before += WEIGHT[ORDER[i]]
  return clamp01(before + WEIGHT[phase] * phaseFraction(done, total))
}

/** The sentence for the step in progress. */
export function phaseLabel(phase: ConvertPhase, done = 0, total = 0): string {
  switch (phase) {
    case 'upload':
      return 'Uploading'
    case 'queue':
      return 'Waiting for the server'
    case 'parse':
      return 'Reading the model'
    case 'draw':
      return total > 0 ? `Drawing sheets ${Math.min(done, total)}/${total}` : 'Drawing sheets'
    case 'write':
      return 'Writing'
    case 'download':
      return 'Downloading'
    case 'open':
      return 'Opening'
    case 'convert':
      return 'Converting (this server reports no progress)'
  }
}

/**
 * Milliseconds left in the step in progress, from its own pace so far (draw: time per sheet times sheets left). Only
 * parse and draw report a count worth extrapolating, and only after `MIN_ETA_SAMPLE_MS` of data: undefined before.
 * The steps after it are not guessed: they differ too much between models.
 */
export function rawEtaMs(phase: ConvertPhase, done: number, total: number, phaseElapsedMs: number): number | undefined {
  if (phase !== 'parse' && phase !== 'draw') return undefined
  const f = phaseFraction(done, total)
  if (f <= 0 || phaseElapsedMs < MIN_ETA_SAMPLE_MS) return undefined
  return (phaseElapsedMs / f) * (1 - f)
}

export interface EtaMemory {
  valueMs: number
  at: number
}

/** Blends a new estimate with the last one, aged by the time since it was made, so the shown number counts down steadily. */
export function smoothEta(previous: EtaMemory | undefined, rawMs: number, now: number): EtaMemory {
  if (!previous) return { valueMs: rawMs, at: now }
  const aged = previous.valueMs - (now - previous.at)
  if (aged <= 0) return { valueMs: rawMs, at: now }
  return { valueMs: KEEP_PREVIOUS * aged + (1 - KEEP_PREVIOUS) * rawMs, at: now }
}

/** "45 s", "1 min 20 s", "2 min". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} s`
  return s === 0 ? `${m} min` : `${m} min ${s} s`
}

/** "about 1 min 20 s left": rounded to 5 s, since a time left to the second is false precision. */
export function formatEta(ms: number): string {
  if (ms < 5000) return 'a few seconds left'
  const rounded = Math.round(ms / 5000) * 5000
  return `about ${formatDuration(rounded)} left`
}

export interface ConvertProgress {
  phase: ConvertPhase
  /** What the person reads: "Drawing sheets 4/13". */
  label: string
  /** Position of the one bar, 0 to 1; null when nothing tells how far it is (the `<progress>` is then indeterminate). */
  fraction: number | null
  /** Since the upload began. */
  elapsedMs: number
  /** Smoothed time left; undefined when it is not known yet. */
  etaMs?: number
}

/** Follows one conversion: feed it the steps as they report, ask it for what to show. */
export class ConvertTracker {
  private startedAt: number
  private phase: ConvertPhase = 'upload'
  private phaseStartedAt: number
  private done = 0
  private total = 0
  private opaque = false
  private highWater = 0
  private eta: EtaMemory | undefined

  constructor(private readonly now: () => number) {
    this.startedAt = this.phaseStartedAt = now()
  }

  update(phase: ConvertPhase, done = 0, total = 0): void {
    if (phase !== this.phase) {
      this.phase = phase
      this.phaseStartedAt = this.now()
      this.eta = undefined
    }
    this.done = done
    this.total = total
  }

  /** The server answered the model directly, with no progress: the bar stops claiming a position. */
  setOpaque(): void {
    this.opaque = true
    this.eta = undefined
  }

  snapshot(): ConvertProgress {
    const t = this.now()
    let fraction: number | null = null
    if (this.phase !== 'convert' && !(this.opaque && this.phase !== 'upload')) {
      // the bar never goes back, however the steps report
      this.highWater = Math.max(this.highWater, overallFraction(this.phase, this.done, this.total))
      fraction = this.highWater
    }
    const raw = rawEtaMs(this.phase, this.done, this.total, t - this.phaseStartedAt)
    if (raw !== undefined) this.eta = smoothEta(this.eta, raw, t)
    const etaMs = raw === undefined || !this.eta ? undefined : Math.max(0, this.eta.valueMs - (t - this.eta.at))
    return { phase: this.phase, label: phaseLabel(this.phase, this.done, this.total), fraction, elapsedMs: t - this.startedAt, etaMs }
  }
}
