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
 * M3-11 grouping: a stroke that starts soon after and close to a reading that
 * has not become an element (pending, offer or markup) joins it. The session is
 * rebuilt on the joined points, so the gesture is read as one stroke, and the
 * decision goes on the gesture's last stroke. See GESTURE in ./live.
 *
 * M4 seam: `setRescorer()` — called after pen-up with the context packet,
 * never awaited by the brush; its answer only adds a suggestion (rule 6).
 */
import type { BrushSettings, DecisionKind, Hypothesis, Sheet, SheetContext, Stroke, StrokePoint } from '@core/types'
import { resolveAnswer } from '@core/rescore'
import { closestPointOnPolyline, snapPoint } from '@core/geometry'
import { commandFromDecision } from '@core/commands'
import { StrokeSession, buildContextPacket, chipsFor, prepareContext } from '@core/predict'
import { withSessionElements } from '@core/context'
import { nextCommandId } from '../board/history'
import { registerBrushEngine, type BrushEngine } from '../engine'
import { pushMetric } from '../metrics'
import { getSession, session as doc } from '../session'
import { getDocState } from '../store'
import { getFilters, hiddenPredicate } from '../drawing/filters'
import { elementsAlong } from '../drawing/inspect'
import { contextNow, emptyContext } from './contextStore'
import { GESTURE, commitPauseFor, getLive, setLive } from './live'
import { considerSecondPass, onSecondPassResult } from './secondPass'

const TICK_MS = 50

interface Current {
  session: StrokeSession
  stroke: Readonly<Stroke>
  sheet: Sheet
  ctx: SheetContext
  settings: BrushSettings
  fed: number
  /** Clock origin of the session's point times (performance.now clock): pen-down minus `offset`. */
  downTs: number
  /** Added to this stroke's point times: where it starts in the gesture's time line (0 for a lone stroke). */
  offset: number
  /** Ids of the earlier strokes of the gesture, oldest first (empty for a lone stroke). */
  members: string[]
  /** Pen-up time (performance.now clock), once the stroke ended. */
  upTs?: number
  timer: ReturnType<typeof setInterval> | null
  /** A second-pass answer applied before commit (M4): commits instead of the rules' leader. */
  applied?: Hypothesis
  /**
   * Eraser pass over a `.drawing` / Revit sheet: the context items of the elements its path hit (set at pen-up).
   * Undefined on other sheets, where the rules' delete reading stands.
   */
  eraseTargets?: string[]
}

let cur: Current | null = null

/**
 * What an eraser pass erases on a sheet drawn from host vectors: the elements under its path, hit-tested on their
 * real lines like the Select tool, any category (walls, doors, grids, dimensions, rooms, ...). Each element is named
 * by its context item when the sheet has one, else by its element id itself (which the delete command and the Revit
 * link take as is). Undefined when the sheet has no vectors (plain PDF).
 */
function eraserTargets(c: Current): string[] | undefined {
  const vp = getDocState().source?.vectorPage?.(c.sheet.id)
  if (!vp) return undefined
  const tol = Math.max((c.stroke.size ?? 8) / 2, 1)
  const els = elementsAlong(vp.page, c.session.stroke.points, tol, hiddenPredicate({ elements: vp.elements }, getFilters()))
  return els.map((el) => c.ctx.items.find((i) => i.hostRef === el)?.id ?? el)
}

const liveOn = () => getSession().settings.live

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
  for (let i = c.fed; i < stroke.points.length; i++) {
    const p = stroke.points[i]
    h = c.session.addPoint(c.offset ? { ...p, t: p.t + c.offset } : p) ?? h
  }
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
  // on host vectors the elements under the eraser decide: erase them, or nothing when it crossed none
  if (eraser && c.eraseTargets) d = c.eraseTargets.length ? { ...d, kind: 'delete', targets: c.eraseTargets.slice(), confidence: Math.max(d.confidence, 0.9) } : { ...d, kind: 'markup' }
  if (d.kind === 'markup' || (eraser && d.kind !== 'delete')) {
    setLive({ phase: 'markup', decision: d, chips: [] })
    return
  }
  // an eraser pass that reads as delete is kept (as an inkless eraser stroke) so the element has a source
  if (eraser && !getSession().strokes.some((s) => s.id === c.stroke.id)) doc.addStroke({ ...c.session.stroke, points: c.session.stroke.points.slice() })
  const command = commandFromDecision(d, nextCommandId(getSession().commands, getSession().commandPrefix, getSession().commandSeq), c.ctx)
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
    if (nowT - c.session.lastPointT < commitPauseFor(c.settings, c.members.length + 1)) return
    const h = c.applied ?? c.session.current
    if (!c.eraseTargets && h && chipsFor(h, c.settings).length === 2) {
      stopTimer(c)
      setLive({ phase: 'offer' })
      return
    }
    if (c.applied && c.applied.kind !== c.session.current?.kind) return commitNow(c, forcedDecision(c, c.applied.kind, c.applied.confidence))
    const d = c.session.tick(nowT, Date.now())
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

/** M3-11: may `stroke` (just put down) join the previous reading as one gesture? */
function joinable(prev: Current | null, stroke: Readonly<Stroke>, sheet: Sheet, downTs: number): prev is Current {
  if (!prev || prev.upTs === undefined || !liveOn()) return false
  const live = getLive()
  if (live.strokeId !== prev.stroke.id || !['pending', 'offer', 'markup'].includes(live.phase)) return false
  if (prev.applied) return false // a second-pass answer was applied to it: let that commit
  if (prev.sheet.id !== sheet.id || stroke.tool === 'eraser' || prev.stroke.tool === 'eraser') return false
  if (downTs - prev.upTs > GESTURE.gapMs) return false
  const start = stroke.points[0]
  if (!start) return false
  const ids = [...prev.members, prev.stroke.id]
  const ink = getSession().strokes.filter((s) => ids.includes(s.id))
  if (ink.length !== ids.length) return false // a member was undone or erased
  if (!ink.some((s) => closestPointOnPolyline(start, s.points).distance <= GESTURE.distPt)) return false
  return !startsOnPendingWall(prev, start)
}

/**
 * C1: a confident wall waiting for its commit pause, and a new stroke that starts on its body rather than at one of
 * its ends: that is the next element (a door on the new wall), not more of the wall. The wall is committed first
 * (settlePrevious), so the new stroke sees it as context. A stroke that starts at an end still joins (a wall drawn
 * in two strokes).
 */
function startsOnPendingWall(prev: Current, start: StrokePoint): boolean {
  const h = prev.applied ?? prev.session.current
  if (!h || h.kind !== 'wall' || chipsFor(h, prev.settings).length || h.confidence < prev.settings.chipHigh) return false
  const pts = prev.session.stroke.points
  if (pts.length < 2) return false
  const end = Math.min(Math.hypot(start.x - pts[0].x, start.y - pts[0].y), Math.hypot(start.x - pts[pts.length - 1].x, start.y - pts[pts.length - 1].y))
  return end > GESTURE.distPt / 2
}

/** The sheet's context with this session's own elements laid over it (C1, core/context withSessionElements). */
export function sessionContext(sheetId: string): SheetContext {
  const s = getSession()
  return withSessionElements(contextNow(sheetId) ?? emptyContext(sheetId), s.commands, { palette: getDocState().source?.palette, skipStrokes: s.hidden })
}

export const predictEngine: BrushEngine = {
  onStrokeStart(stroke, sheet, { downTs }) {
    const prev = cur
    const join = joinable(prev, stroke, sheet, downTs)
    if (join) {
      stopTimer(prev)
      cur = null
    } else settlePrevious()
    if (!liveOn()) {
      setLive({ phase: 'idle', strokeId: stroke.id, sheetId: sheet.id, gesture: [stroke.id], history: [], hypothesis: undefined, chips: [], snapStart: undefined, snapEnd: undefined, decision: undefined, suggestion: undefined, origin: 'rules' })
      return
    }
    const settings = { ...getSession().settings }
    const palette = getDocState().source?.palette
    // C1: walls sketched earlier in this session are context too, so a door drawn on one is hosted in it
    const ctx = sessionContext(sheet.id)
    const history = getSession().accepted
    let c: Current
    if (join) {
      // continue the previous gesture's time line: its points, the pause, then this stroke
      const before = prev.session.stroke
      const offset = before.points.length ? before.points[before.points.length - 1].t + (downTs - prev.upTs!) : 0
      const joined: Stroke = { ...stroke, startedAt: before.startedAt ?? stroke.startedAt, points: before.points.slice() }
      const session = new StrokeSession(joined, prev.ctx, settings, { history, palette })
      c = { session, stroke, sheet, ctx: prev.ctx, settings, fed: 0, downTs: downTs - offset, offset, members: [...prev.members, prev.stroke.id], timer: null }
      const gestures = { ...getLive().gestures }
      delete gestures[prev.stroke.id]
      gestures[stroke.id] = [...c.members, stroke.id]
      setLive({ gestures })
    } else {
      const session = new StrokeSession({ ...stroke, points: [] }, ctx, settings, { history, palette })
      c = { session, stroke, sheet, ctx, settings, fed: 0, downTs, offset: 0, members: [], timer: null }
    }
    cur = c
    const h = feed(c, stroke)
    publish(c, h, {
      phase: 'drawing',
      strokeId: stroke.id,
      gesture: [...c.members, stroke.id],
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
    c.upTs = performance.now()
    const h = c.session.end()
    if (c.stroke.tool === 'eraser') c.eraseTargets = eraserTargets(c)
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
