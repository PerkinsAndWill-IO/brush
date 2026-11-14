import type { ContextPacket, Hypothesis, Rescorer } from '../types'
import { AbortedError } from './cassette'
import { shouldRescore, type RescoreSettings } from './policy'

export interface RescoreRequest {
  strokeId: string
  /** Hypothesis.run of the hypothesis being rescored (rule 6 compares it on arrival). */
  run: number | undefined
  packet: ContextPacket
  /** First-pass hypotheses, leader first (usually just the live one). */
  candidates: Hypothesis[]
}

export interface RescoreResult {
  strokeId: string
  run: number | undefined
  status: 'ok' | 'error' | 'timeout' | 'aborted'
  /** Re-ranked hypotheses, best first; empty unless status is 'ok'. */
  hypotheses: Hypothesis[]
  latencyMs: number
  error?: string
}

export interface RescoreRunnerOptions {
  rescorer: Rescorer
  settings: Pick<RescoreSettings, 'adapter' | 'ambiguousBelow' | 'ambiguousMargin' | 'timeoutMs'>
  /** Monotonic clock in ms (performance.now in the app). */
  now: () => number
  /** Called asynchronously, never from inside consider()/start(). */
  onResult: (r: RescoreResult) => void
  /** Keep at most this many latency samples (default 5000). */
  maxSamples?: number
}

/**
 * Runs the second pass OFF the critical path (M4-03). `consider()` / `start()`
 * return synchronously after kicking off the request; the first pass and the
 * commit never await it. Each request is aborted after `timeoutMs`; a newer
 * request for the same stroke aborts the older one. Answers arrive through
 * `onResult`; feed them to `resolveAnswer` (rule 6) to apply / suggest / drop.
 */
export class RescoreRunner {
  /** Latency of every answered call (status 'ok'), ms — the secondPassMs samples. */
  readonly secondPassMs: number[] = []
  readonly counts = { started: 0, ok: 0, error: 0, timeout: 0, aborted: 0 }
  private readonly inflight = new Map<string, { ctrl: AbortController; done: Promise<void> }>()
  private readonly opts: RescoreRunnerOptions

  constructor(opts: RescoreRunnerOptions) {
    this.opts = opts
  }

  /** Starts a second pass only if the policy says the leader is ambiguous. Returns whether it started. */
  consider(req: RescoreRequest): boolean {
    const lead = req.candidates[0]
    if (!lead || !shouldRescore(lead, this.opts.settings)) return false
    this.start(req)
    return true
  }

  /** Starts a second pass regardless of the policy (still never blocks). */
  start(req: RescoreRequest): void {
    this.cancel(req.strokeId)
    const ctrl = new AbortController()
    const t0 = this.opts.now()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, this.opts.settings.timeoutMs)
    this.counts.started++
    const call = (this.opts.rescorer.rescore as (p: ContextPacket, c: Hypothesis[], s?: AbortSignal) => Promise<Hypothesis[]>).bind(this.opts.rescorer)
    // Defer the call itself so even a rescorer that does synchronous work before its first await cannot delay the caller.
    const done = Promise.resolve()
      .then(() => {
        if (ctrl.signal.aborted) throw new AbortedError()
        return call(req.packet, req.candidates, ctrl.signal)
      })
      .then(
        (hypotheses): RescoreResult => {
          if (ctrl.signal.aborted) return this.result(req, timedOut ? 'timeout' : 'aborted', t0)
          return { ...this.result(req, 'ok', t0), hypotheses }
        },
        (e: unknown): RescoreResult => {
          if (ctrl.signal.aborted) return this.result(req, timedOut ? 'timeout' : 'aborted', t0)
          return { ...this.result(req, 'error', t0), error: e instanceof Error ? e.message : String(e) }
        },
      )
      .then((r) => {
        clearTimeout(timer)
        if (this.inflight.get(req.strokeId)?.ctrl === ctrl) this.inflight.delete(req.strokeId)
        this.counts[r.status]++
        if (r.status === 'ok') {
          this.secondPassMs.push(r.latencyMs)
          const max = this.opts.maxSamples ?? 5000
          if (this.secondPassMs.length > max) this.secondPassMs.splice(0, this.secondPassMs.length - max)
        }
        this.opts.onResult(r)
      })
    this.inflight.set(req.strokeId, { ctrl, done })
  }

  /** Aborts the in-flight request for a stroke (or all). */
  cancel(strokeId?: string): void {
    for (const [id, f] of this.inflight) if (strokeId === undefined || id === strokeId) f.ctrl.abort()
  }

  get pending(): number {
    return this.inflight.size
  }

  /** Resolves when every in-flight request has reported (tests / eval only). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight.values()].map((f) => f.done))
  }

  private result(req: RescoreRequest, status: RescoreResult['status'], t0: number): RescoreResult {
    return { strokeId: req.strokeId, run: req.run, status, hypotheses: [], latencyMs: this.opts.now() - t0 }
  }
}

/** p-quantile (nearest rank) of samples; NaN when empty. */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}
