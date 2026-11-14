/**
 * The contextual brush in the app (M2 snapping markers + M3 streaming
 * prediction), plugged into the board through the BrushEngine hooks.
 *
 * One core/predict StrokeSession per stroke:
 *   pen down → session + first hypothesis (rule 1)
 *   each frame with new points → addPoint (self-throttled to refreshMs)
 *   pen up → end(); then a 50 ms timer calls tick() until the commit pause (rule 5)
 *   commit → AcceptedDecision + Command into the session history (undoable, autosaved)
 * Confidence in [chipLow, chipHigh) at commit time does not auto-commit: two
 * chips are offered and the user taps one (state 6); otherwise the ink stays.
 * Below chipLow the reading is markup and the ink stays ink (rule 7).
 *
 * M4 seam: `setRescorer()` — called after pen-up with the context packet,
 * never awaited by the brush; its answer only adds a suggestion (rule 6).
 */
import type { BrushSettings, DecisionKind, Hypothesis, Sheet, SheetContext, Stroke, StrokePoint } from '@core/types'
import { resolveAnswer } from '@core/rescore'
import { snapPoint } from '@core/geometry'
import { commandFromDecision } from '@core/commands'
import { withDrawnWalls } from '@core/context'
import { StrokeSession, buildContextPacket, chipsFor, prepareContext } from '@core/predict'
import { nextCommandId } from '../board/history'
import { registerBrushEngine, type BrushEngine } from '../engine'
import { pushMetric } from '../metrics'
import { getSession, session as doc } from '../session'
import { getDocState } from '../store'
import { contextNow, emptyContext } from './contextStore'
import { getLive, setLive } from './live'
import { considerSecondPass, onSecondPassResult } from './secondPass'

const TICK_MS = 50

interface Current {
  session: StrokeSession
  stroke: Readonly<Stroke>
  sheet: Sheet
  ctx: SheetContext
  settings: BrushSettings
  fed: number
  downTs: number
  timer: ReturnType<typeof setInterval> | null
  /** A second-pass answer applied before commit (M4): commits instead of the rules' leader. */
  applied?: Hypothesis
}

let cur: Current | null = null

const liveOn = () => getSession().settings.live

/**
 * The sheet's context plus the walls drawn on it, so new walls snap to them and doors land in them.
 * Memoised on (context, accepted list) so the prepared context is only rebuilt when either changes.
 */
let drawnMemo: { base: SheetContext; accepted: readonly unknown[]; out: SheetContext } | null = null
function contextWithDrawn(base: SheetContext): SheetContext {
  const { accepted, commands } = getSession()
  if (drawnMemo && drawnMemo.base === base && drawnMemo.accepted === accepted) return drawnMemo.out
  const refs = new Map<string, string>()
  for (const c of commands) if (c.op === 'create_wall' && c.strokeId) refs.set(c.strokeId, c.id)
  const out = withDrawnWalls(base, accepted, { palette: getDocState().source?.palette, refs })
  drawnMemo = { base, accepted, out }
  return out
}

function snapEnds(c: Current, which: 'start' | 'end' | 'both') {
  const { settings, ctx } = c
  if (!settings.snapping || ctx.shapeOnly || !ctx.items.length) return {}
  const lines = prepareContext(ctx).lines
  const pts = c.session.stroke.points
  if (!pts.length) return {}
  const at = (p: StrokePoint) => {
    const r = snapPoint(p, lines, { radius: settings.snapRadiusPt })
    return r.kind === 'none' ? undefined : r
  }
  const out: { snapStart?: ReturnType<typeof at>; snapEnd?: ReturnType<typeof at> } = {}
  if (which !== 'end') out.snapStart = at(pts[0])
  if (which !== 'start' && pts.length > 1) out.snapEnd = at(pts[pts.length - 1])
  return out
}

function publish(c: Current, h: Hypothesis | null | undefined, extra: Parameters<typeof setLive>[0] = {}) {
  const pts = c.session.stroke.points
  const next: Parameters<typeof setLive>[0] = { history: c.session.hypotheses.slice(), pen: pts[pts.length - 1], ...extra }
  if (h) {
    next.hypothesis = h
    next.chips = chipsFor(h, c.settings)
  }
  setLive(next)
}

function feed(c: Current, stroke: Readonly<Stroke>): Hypothesis | null {
  let h: Hypothesis | null = null
  for (let i = c.fed; i < stroke.points.length; i++) h = c.session.addPoint(stroke.points[i]) ?? h
  c.fed = stroke.points.length
  return h
}

function stopTimer(c: Current) {
  if (c.timer) clearInterval(c.timer)
  c.timer = null
}

function commitNow(c: Current, d = c.session.commit(Date.now())) {
  stopTimer(c)
  const eraser = c.stroke.tool === 'eraser'
  if (d.kind === 'markup' || (eraser && d.kind !== 'delete')) {
    setLive({ phase: 'markup', decision: d, chips: [] })
    return
  }
  // an eraser pass that reads as delete is kept (as an inkless eraser stroke) so the element has a source
  if (eraser && !getSession().strokes.some((s) => s.id === c.stroke.id)) doc.addStroke({ ...c.session.stroke, points: c.session.stroke.points.slice() })
  const command = commandFromDecision(d, nextCommandId(getSession().commands), c.ctx)
  doc.commitDecision(d, command)
  const shown = [c.applied, c.session.current, getLive().hypothesis].find((h) => h?.kind === d.kind) ?? getLive().hypothesis
  setLive({ phase: 'committed', decision: d, chips: [], hypothesis: shown && { ...shown, stable: true } })
}

/** Finish whatever the previous stroke was waiting for before a new one starts. */
function settlePrevious() {
  const c = cur
  if (!c) return
  stopTimer(c)
  const phase = getLive().phase
  if (phase === 'pending') commitNow(c)
  else if (phase === 'offer') setLive({ phase: 'markup', chips: [] }) // not picked: the ink stays ink
  cur = null
}

function startTimer(c: Current) {
  c.timer = setInterval(() => {
    if (cur !== c) return stopTimer(c)
    if (c.stroke.tool !== 'eraser' && !getSession().strokes.some((s) => s.id === c.stroke.id)) {
      // the stroke was undone or erased before its commit
      stopTimer(c)
      cur = null
      setLive({ phase: 'idle', hypothesis: undefined, chips: [], snapStart: undefined, snapEnd: undefined })
      return
    }
    const nowT = performance.now() - c.downTs
    if (nowT - c.session.lastPointT < c.settings.commitPauseMs) return
    const h = c.applied ?? c.session.current
    if (h && chipsFor(h, c.settings).length === 2) {
      stopTimer(c)
      setLive({ phase: 'offer' })
      return
    }
    if (c.applied && c.applied.kind !== c.session.current?.kind) return commitNow(c, forcedDecision(c, c.applied.kind, c.applied.confidence))
    const d = c.session.tick(nowT, (c.stroke.startedAt ?? Date.now()) + nowT)
    if (d) commitNow(c, d)
  }, TICK_MS)
}

function askSecondPass(c: Current, h: Hypothesis) {
  const packet = buildContextPacket({ stroke: c.session.stroke, ctx: c.ctx, evidence: c.session.predictor.lastTrace?.evidence }, h, getSession().accepted.slice(-3))
  if (considerSecondPass({ strokeId: c.stroke.id, run: h.run, packet, candidates: [h] })) setLive({ asking: true })
}

// Rule 6 for second-pass answers: apply before commit (same run), a suggestion chip after commit, else drop.
onSecondPassResult((r, rs) => {
  const live = getLive()
  if (live.strokeId === r.strokeId) setLive({ asking: false })
  if (r.status !== 'ok') return
  const committed = live.strokeId === r.strokeId && (live.phase === 'committed' || live.phase === 'markup') ? live.decision : getSession().accepted.find((a) => a.strokeId === r.strokeId)
  const res = resolveAnswer(r, { strokeId: live.strokeId ?? '', run: live.hypothesis?.run, committed }, rs)
  if (res.action === 'apply') {
    const c = cur
    if (!c || c.stroke.id !== r.strokeId) return
    c.applied = res.hypothesis
    setLive({ hypothesis: res.hypothesis, chips: chipsFor(res.hypothesis, c.settings), origin: 'model' })
  } else if (res.action === 'suggest' && live.strokeId === res.strokeId) {
    setLive({ suggestion: { strokeId: res.strokeId, ...res.chip } })
  }
})

export const predictEngine: BrushEngine = {
  onStrokeStart(stroke, sheet, { downTs }) {
    settlePrevious()
    if (!liveOn()) {
      setLive({ phase: 'idle', strokeId: stroke.id, sheetId: sheet.id, history: [], hypothesis: undefined, chips: [], snapStart: undefined, snapEnd: undefined, decision: undefined, suggestion: undefined, origin: 'rules' })
      return
    }
    const settings = { ...getSession().settings }
    const ctx = contextWithDrawn(contextNow(sheet.id) ?? emptyContext(sheet.id))
    const history = getSession().accepted
    const palette = getDocState().source?.palette
    const session = new StrokeSession({ ...stroke, points: [] }, ctx, settings, { history, palette })
    const c: Current = { session, stroke, sheet, ctx, settings, fed: 0, downTs, timer: null }
    cur = c
    const h = feed(c, stroke)
    publish(c, h, {
      phase: 'drawing',
      strokeId: stroke.id,
      sheetId: sheet.id,
      downTs,
      decision: undefined,
      origin: 'rules',
      suggestion: undefined,
      asking: false,
      snapEnd: undefined,
      shapeOnly: !!ctx.shapeOnly || ctx.items.length === 0,
      ...snapEnds(c, 'start'),
    })
    // M3 budget mark: pointer-down → the frame in which the first hypothesis is on screen
    // (the overlays and the Reading panel render from this store update before that frame paints).
    if (h)
      requestAnimationFrame(() => {
        const ms = performance.now() - downTs
        pushMetric('firstHypothesisMs', ms)
        if (cur === c) setLive({ lastFirstMs: ms })
      })
  },

  onStrokeUpdate(stroke) {
    const c = cur
    if (!c || c.stroke.id !== stroke.id) return
    const h = feed(c, stroke)
    if (h) publish(c, h, snapEnds(c, 'end'))
  },

  onStrokeEnd(stroke, _sheet, { committed }) {
    const c = cur
    if (!c || c.stroke.id !== stroke.id) return
    if (!committed) {
      cur = null
      setLive({ phase: 'idle', hypothesis: undefined, chips: [], snapStart: undefined, snapEnd: undefined })
      return
    }
    feed(c, stroke)
    const h = c.session.end()
    publish(c, h, { phase: 'pending', ...snapEnds(c, 'both') })
    if (h) askSecondPass(c, h)
    startTimer(c)
  },
}

function forcedDecision(c: Current, kind: DecisionKind, confidence?: number) {
  const forced = new StrokeSession(c.session.stroke, c.ctx, { ...c.settings, mode: kind }, { history: getSession().accepted, palette: getDocState().source?.palette })
  const d = forced.commit(Date.now())
  if (confidence !== undefined) d.confidence = confidence
  return d
}

/** Tap on a chip (state 6), or a reading picked in the Reading panel: commit that kind now. */
export function acceptReading(kind: DecisionKind) {
  const c = cur
  if (!c || !['pending', 'offer'].includes(getLive().phase)) return
  const h = getLive().hypothesis
  const conf = h?.kind === kind ? h.confidence : h?.alternatives.find((a) => a.kind === kind)?.confidence
  commitNow(c, forcedDecision(c, kind, conf))
}

/** Esc / dismiss: keep the pending stroke as plain ink. */
export function dismissReading() {
  const c = cur
  if (!c) return
  stopTimer(c)
  if (['pending', 'offer'].includes(getLive().phase)) setLive({ phase: 'markup', chips: [] })
  cur = null
}

let installed: (() => void) | null = null
export function installPredictEngine() {
  installed ??= registerBrushEngine(predictEngine)
}
