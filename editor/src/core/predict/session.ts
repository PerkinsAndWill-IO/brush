import type { AcceptedDecision, BrushSettings, Hypothesis, SheetContext, Stroke, StrokePoint } from '../types'
import { appendPoint } from '../stroke'
import { StreamingPredictor, type PredictorOptions } from './predictor'

/**
 * Engine rule 5 as a pure helper: commit once `commitPauseMs` passed without
 * new points. Times are stroke times (ms since pen-down) or any one clock, as
 * long as both arguments use the same one.
 */
export function shouldCommit(lastPointT: number, nowT: number, settings: Pick<BrushSettings, 'commitPauseMs'>): boolean {
  return nowT - lastPointT >= settings.commitPauseMs
}

/**
 * One stroke from pen-down to commit — what the canvas drives.
 *
 *   const s = new StrokeSession(stroke, ctx, settings, { history })
 *   onPointerMove: const h = s.addPoint(pt)      // Hypothesis when a run happened (≤ 1 per refreshMs), else null
 *   onPointerUp:   s.end()                       // final run on the full stroke
 *   on a timer:    const d = s.tick(nowT)        // AcceptedDecision once nowT - lastPointT ≥ commitPauseMs, else null
 *
 * `nowT` is in stroke time (ms since pen-down, same clock as the points' `t`).
 * After commit the decision is frozen (rule 6): later points are ignored and
 * `addPoint` returns null; start a new session for the next stroke.
 */
export class StrokeSession {
  readonly stroke: Stroke
  readonly predictor: StreamingPredictor
  private decision?: AcceptedDecision
  private ended = false

  constructor(
    stroke: Stroke,
    private ctx: SheetContext,
    private settings: BrushSettings,
    opts: PredictorOptions = {},
  ) {
    this.stroke = { ...stroke, points: stroke.points.slice() }
    this.predictor = new StreamingPredictor(opts)
  }

  get committed(): AcceptedDecision | undefined {
    return this.decision
  }

  /** All hypotheses produced for this stroke, one per run. */
  get hypotheses(): Hypothesis[] {
    return this.predictor.hypotheses
  }

  get current(): Hypothesis | undefined {
    return this.predictor.lastTrace?.hypothesis
  }

  get lastPointT(): number {
    const p = this.stroke.points
    return p.length ? p[p.length - 1].t : 0
  }

  /** Append a point; returns the new hypothesis when this point triggered a run (rule 1). */
  addPoint(pt: StrokePoint): Hypothesis | null {
    if (this.decision || this.ended) return null
    const before = this.predictor.lastTrace
    appendPoint(this.stroke, pt)
    const h = this.predictor.update(this.snapshot(), this.ctx, this.settings)
    return this.predictor.lastTrace !== before ? h : null
  }

  /** Pen up: one last run on the full stroke. */
  end(): Hypothesis | undefined {
    this.ended = true
    if (!this.stroke.points.length) return undefined
    return this.predictor.flush(this.snapshot(), this.ctx, this.settings)
  }

  /**
   * Call periodically (and/or after pen up). Commits when the pen paused for
   * commitPauseMs. `committedAt` (epoch ms) is recorded on the decision; it
   * defaults to `stroke.startedAt + nowT` or `nowT`.
   */
  tick(nowT: number, committedAt?: number): AcceptedDecision | null {
    if (this.decision) return null
    if (!this.stroke.points.length || !shouldCommit(this.lastPointT, nowT, this.settings)) return null
    return this.commit(committedAt ?? (this.stroke.startedAt ?? 0) + nowT)
  }

  /** Commit now (e.g. the user picked a chip, or the app forces it). Idempotent. */
  commit(committedAt: number): AcceptedDecision {
    if (!this.decision) this.decision = this.predictor.commit(this.snapshot(), this.ctx, this.settings, committedAt)
    return this.decision
  }

  private snapshot(): Stroke {
    return { ...this.stroke, points: this.stroke.points.slice() }
  }
}
