import {
  DECISION_KINDS,
  type AcceptedDecision,
  type Alternative,
  type BrushSettings,
  type DecisionKind,
  type Hypothesis,
  type Predictor,
  type SheetContext,
  type Stroke,
} from '../types'
import { DEFAULT_PALETTE, type TypePalette } from '../context'
import { gatherEvidence, type Evidence } from './evidence'
import { KINDS_FOR_COARSE, RULES, coarseOf, scoreKinds, type Coarse } from './score'
import { initialStability, stabilityStep, type StabilityState } from './stability'
import { shapeFor } from './shape'
import { defaultSequencePrior, type SequencePrior } from './history'

export const PREDICTOR_NAME = 'rules-v1'

export interface PredictorOptions {
  /** Types to pick from in refinement step 3. Default: the built-in palette (plain PDF). */
  palette?: TypePalette
  /** Accepted decisions earlier in the session (oldest first), for sequence priors. */
  history?: readonly AcceptedDecision[]
  sequencePrior?: SequencePrior
}

/** Everything one run produced, kept for tests, the Reading panel and the M4 context packet. */
export interface RunTrace {
  hypothesis: Hypothesis
  evidence: Evidence
  coarse: Coarse
  /** Normalised confidence per kind for this run (before stability). */
  probs: Record<DecisionKind, number>
}

const emptyProbs = (): Record<DecisionKind, number> => ({ wall: 0, door: 0, furniture: 0, delete: 0, markup: 0 })

/** Chips to show for a hypothesis (engine rule 7): top two when chipLow <= confidence < chipHigh. */
export function chipsFor(h: Hypothesis, settings: Pick<BrushSettings, 'chipLow' | 'chipHigh'>): DecisionKind[] {
  if (h.kind === 'markup' || h.confidence < settings.chipLow || h.confidence >= settings.chipHigh) return []
  const second = h.alternatives[0]
  return second ? [h.kind, second.kind] : [h.kind]
}

/**
 * Streaming first pass (docs/spec.md engine rules 1-7). ONE INSTANCE PER STROKE:
 * it carries the stability state, the refresh throttle and the frozen decision
 * of the stroke in progress. Call `reset()` (or make a new one) for the next stroke.
 *
 * - `update()` may be called on every pointer move; it re-runs at most every
 *   `settings.refreshMs` of stroke time (`t` of the last point) and returns the
 *   cached hypothesis otherwise. The first call always runs (first hypothesis).
 * - `flush()` forces a run on the current points (pen up / before commit).
 * - `commit()` flushes, freezes and returns the AcceptedDecision; afterwards
 *   `update()` / `flush()` return the frozen hypothesis unchanged (rule 6).
 *
 * Deterministic: same call sequence, same output. No clocks are read.
 */
export class StreamingPredictor implements Predictor {
  readonly name = PREDICTOR_NAME
  private opts: PredictorOptions
  private stab: StabilityState = initialStability()
  private lastRunT = -Infinity
  private lastN = 0
  private runs = 0
  private leaderRuns = 0
  private last?: RunTrace
  private frozen?: { hypothesis: Hypothesis; decision: AcceptedDecision }
  private trace: RunTrace[] = []
  private finalDone = false
  private smoothed?: Record<DecisionKind, number>

  constructor(opts: PredictorOptions = {}) {
    this.opts = opts
  }

  /** Forget the stroke in progress (keeps palette/history options). */
  reset(opts?: PredictorOptions): void {
    if (opts) this.opts = opts
    this.stab = initialStability()
    this.lastRunT = -Infinity
    this.lastN = 0
    this.runs = 0
    this.leaderRuns = 0
    this.last = undefined
    this.frozen = undefined
    this.trace = []
    this.finalDone = false
    this.smoothed = undefined
  }

  /** Hypotheses produced so far for this stroke, in order (one per run). */
  get hypotheses(): Hypothesis[] {
    return this.trace.map((r) => r.hypothesis)
  }

  get lastTrace(): RunTrace | undefined {
    return this.last
  }

  get committed(): AcceptedDecision | undefined {
    return this.frozen?.decision
  }

  /** True when `update` would re-run for a stroke whose last point is at `t` ms. */
  isDue(t: number, settings: Pick<BrushSettings, 'refreshMs'>): boolean {
    return !this.last || t - this.lastRunT >= settings.refreshMs
  }

  update(stroke: Stroke, ctx: SheetContext, settings: BrushSettings): Hypothesis {
    if (this.frozen) return this.frozen.hypothesis
    const n = stroke.points.length
    if (n === 0) return this.last?.hypothesis ?? emptyHypothesis()
    const t = stroke.points[n - 1].t
    if (this.last && (n === this.lastN || !this.isDue(t, settings))) return this.last.hypothesis
    return this.run(stroke, ctx, settings)
  }

  /**
   * Final run on the finished stroke (pen up / pause). The stroke can no longer change,
   * so this run is its own confirmation: a challenger leading by switchMargin takes over
   * here without waiting for a second run (rule 4 guards against flicker while drawing).
   */
  flush(stroke: Stroke, ctx: SheetContext, settings: BrushSettings): Hypothesis {
    if (this.frozen) return this.frozen.hypothesis
    if (stroke.points.length === 0) return this.last?.hypothesis ?? emptyHypothesis()
    if (this.last && this.finalDone && stroke.points.length === this.lastN) return this.last.hypothesis
    return this.run(stroke, ctx, settings, true)
  }

  commit(stroke: Stroke, ctx: SheetContext, settings: BrushSettings, committedAt: number): AcceptedDecision {
    if (this.frozen) return this.frozen.decision
    const h = { ...this.flush(stroke, ctx, settings), stable: true }
    const decision: AcceptedDecision = {
      strokeId: stroke.id,
      sheetId: stroke.sheetId,
      kind: h.kind,
      geometry: h.geometry,
      confidence: h.confidence,
      committedAt,
    }
    if (h.type !== undefined) decision.type = h.type
    if (h.targets !== undefined) decision.targets = h.targets.slice()
    this.frozen = { hypothesis: h, decision }
    return decision
  }

  private run(stroke: Stroke, ctx: SheetContext, settings: BrushSettings, final = false): Hypothesis {
    this.finalDone = final
    const n = stroke.points.length
    const t = stroke.points[n - 1].t
    this.lastRunT = t
    this.lastN = n
    const runIndex = ++this.runs
    const palette = this.opts.palette ?? DEFAULT_PALETTE

    const ev = gatherEvidence(stroke, ctx, { snapRadiusPt: settings.snapRadiusPt })
    // step 1: coarse class
    const coarse = coarseOf(ev)
    // step 2: kind scores
    const rr = scoreKinds(ev)
    const prior = (this.opts.sequencePrior ?? defaultSequencePrior)(this.opts.history ?? [])
    const allowed = new Set<DecisionKind>(settings.allowedKinds?.length ? [...settings.allowedKinds, 'markup'] : DECISION_KINDS)
    const compatible = new Set<DecisionKind>(KINDS_FOR_COARSE[coarse])
    // Raw scores are smoothed over runs while drawing (half old, half new) so a transient dip
    // in one fit does not flicker the reading; the final run on the finished stroke uses them as is.
    const fresh = emptyProbs()
    for (const k of DECISION_KINDS) fresh[k] = Math.max(0, rr.scores[k] * (prior[k] ?? 1))
    const prev = this.smoothed
    const smooth = emptyProbs()
    for (const k of DECISION_KINDS) smooth[k] = prev && !final ? RULES.smoothing * prev[k] + (1 - RULES.smoothing) * fresh[k] : fresh[k]
    this.smoothed = smooth
    const raw = emptyProbs()
    let sum = 0
    for (const k of DECISION_KINDS) {
      const ok = k === 'markup' || (allowed.has(k) && compatible.has(k))
      raw[k] = ok ? smooth[k] : 0
      sum += raw[k]
    }
    const probs = emptyProbs()
    for (const k of DECISION_KINDS) probs[k] = sum > 0 ? raw[k] / sum : k === 'markup' ? 1 : 0

    // gated top: a kind below chipLow cannot lead (rule 7); markup is the fallback
    let top: DecisionKind = 'markup'
    for (const k of DECISION_KINDS) {
      if (k !== 'markup' && probs[k] >= settings.chipLow && probs[k] > probs[top]) top = k
    }

    // forced switches: mode, or the leader became incompatible with step 1 / fell below chipLow
    let forced: DecisionKind | undefined
    const mode = settings.mode
    if (mode !== 'auto') forced = mode
    else {
      const L = this.stab.leader
      if (L !== undefined && L !== 'markup' && (!compatible.has(L) || !allowed.has(L) || probs[L] < settings.chipLow)) forced = top
    }
    const step = stabilityStep(this.stab, probs, top, settings.switchMargin, final ? 1 : settings.switchRuns, forced)
    const prevLeader = this.stab.leader
    this.stab = step.state
    const kind = step.leader
    this.leaderRuns = prevLeader === kind ? this.leaderRuns + 1 : 1

    // step 3: type + fitted, snapped geometry
    const shaped = shapeFor(kind, ev, settings, palette, rr.targets)
    const confidence = mode !== 'auto' ? 1 : probs[kind]
    const alternatives: Alternative[] = DECISION_KINDS.filter((k) => k !== kind && probs[k] > 0)
      .map((k) => ({ kind: k, confidence: probs[k] }))
      .sort((a, b) => b.confidence - a.confidence || DECISION_KINDS.indexOf(a.kind) - DECISION_KINDS.indexOf(b.kind))

    const evidence = [`step 1: ${coarse}`, ...rr.evidence, ...shaped.evidence]
    if (mode !== 'auto') evidence.push(`mode forces ${mode}`)
    else if (forced !== undefined && step.switched) evidence.push(`forced switch: ${prevLeader} no longer fits (${coarse}, ${(probs[prevLeader as DecisionKind] ?? 0).toFixed(2)})`)
    if (settings.allowedKinds?.length) evidence.push(`narrowed to ${settings.allowedKinds.join(', ')}`)
    if (step.state.challenger) evidence.push(`${step.state.challenger} challenging (${step.state.count}/${settings.switchRuns})`)

    const h: Hypothesis = {
      kind,
      geometry: shaped.geometry,
      confidence,
      alternatives,
      stable: step.settled && this.leaderRuns >= settings.switchRuns,
      coarse,
      run: runIndex,
      atMs: t,
      evidence,
    }
    if (shaped.type !== undefined && kind !== 'markup') h.type = shaped.type
    const targets = shaped.targets ?? rr.targets[kind]
    if ((kind === 'door' || kind === 'delete') && targets?.length) h.targets = targets.slice()
    const tr: RunTrace = { hypothesis: h, evidence: ev, coarse, probs }
    this.last = tr
    this.trace.push(tr)
    return h
  }
}

function emptyHypothesis(): Hypothesis {
  return { kind: 'markup', geometry: { points: [], closed: false }, confidence: 0, alternatives: [], stable: false, run: 0 }
}

export function createPredictor(opts?: PredictorOptions): StreamingPredictor {
  return new StreamingPredictor(opts)
}
