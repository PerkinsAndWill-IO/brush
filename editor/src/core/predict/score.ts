import type { DecisionKind } from '../types'
import type { Evidence } from './evidence'

/**
 * Rule-based scoring, one rule per decision kind (docs/spec.md "Decision vocabulary").
 * Every rule returns a raw score in 0..1 plus evidence lines for the Reading panel.
 * Raw scores are normalised into confidences in predictor.ts.
 *
 * Rules are phrased in shape-agnostic terms (span, aspect of the oriented box, closure,
 * ink density, relation to walls) rather than per-primitive constants, so they hold for
 * different drawing habits. Tuned on the train splits only (`pnpm eval --split=train`,
 * with and without `--corpus=`); held-out strokes never.
 */

export type Coarse = 'linear' | 'closed' | 'unknown'

/** Step 1 → step 2 compatibility: which kinds each coarse class allows. Markup is always allowed. */
export const KINDS_FOR_COARSE: Record<Coarse, readonly DecisionKind[]> = {
  linear: ['wall', 'door', 'markup'],
  closed: ['furniture', 'markup'],
  unknown: ['wall', 'door', 'furniture', 'delete', 'markup'],
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
/** 0 below a, 1 above b, linear in between. */
export const ramp = (x: number, a: number, b: number): number => clamp01((x - a) / (b - a))
/** Trapezoid: 0 outside [a,d], 1 inside [b,c]. */
export const bump = (x: number, a: number, b: number, c: number, d: number): number => Math.min(ramp(x, a, b), 1 - ramp(x, c, d))

const DEG = Math.PI / 180

/** Weights and thresholds, in one place so tuning is visible. Lengths in metres. */
export const RULES = {
  /** Strokes shorter than this are too early to read. */
  minLengthM: 0.25,
  scribbleRev: [0.8, 2.0] as const,
  hairpins: [1.5, 3.5] as const,
  /** Looping scribbles: self-intersections per metre and ink per box size. */
  loopsPerM: [0.75, 1.05] as const,
  inkDensity: [2.8, 3.8] as const,
  wallLen: [0.8, 1.6] as const,
  wallLongLen: [3, 5] as const,
  /** Door widths: the span of a tick, the side of a swing. */
  doorSpan: [0.45, 0.6, 1.35, 1.7] as const,
  doorArcSpan: [0.55, 0.7, 1.6, 2.0] as const,
  doorArcStraightness: [0.7, 0.8, 0.95, 0.98] as const,
  /** Thin = minor/major side of the oriented box below this (ticks, retraced lines). */
  thinAspect: [0.25, 0.4] as const,
  furnitureSize: [0.3, 0.45, 2.6, 3.4] as const,
  markupBase: 0.28,
  deleteScribblePow: 1.5,
  /** Weight of the previous run's raw scores while drawing (0 = no smoothing). */
  smoothing: 0.65,
  shapeOnlyFactor: 0.8,
}

const spanM = (ev: Evidence) => ev.spanPt / ev.ptPerM

/** Coarse class, refinement step 1. */
export function coarseOf(ev: Evidence): Coarse {
  const f = ev.f
  if (ev.stroke.tool === 'eraser') return 'unknown'
  if (ev.lengthM < RULES.minLengthM || f.fits.length === 0) return 'unknown'
  const sc = scribbleness(ev)
  if (sc >= 0.35 || (ev.inkDensity >= 2.6 && ev.ringness < 0.5)) return 'unknown'
  // a thin stroke is a line even when retraced back onto its start
  // no primitive explains it (wiggles, hatching): leave every kind open
  const bestFit = Math.max(ev.fit.line?.score ?? 0, ev.fit.polyline?.score ?? 0, ev.fit.arc?.score ?? 0, ev.fit.rectangle?.score ?? 0)
  if (bestFit < 0.5 && f.closureRatio > 0.3) return 'unknown'
  if (ev.aspect < 0.22) return 'linear'
  if (f.closureRatio < 0.2 || (f.closureRatio < 0.3 && f.cornerCount >= 3)) return 'closed'
  return 'linear'
}

/**
 * Scribble-ness 0..1: a zig-zag (scribble fit or many corners) with many reversals,
 * dense or long; early in the stroke, repeated hairpin turns in the polyline fit;
 * or a looping scribble (many self-intersections, a lot of ink in a small box).
 */
export function scribbleness(ev: Evidence): number {
  const f = ev.f
  const scr = ev.fit.scribble?.score ?? 0
  const reversals = (f.reversalDensity * f.lengthPt) / 100
  const zigzag = Math.max(scr, ramp(f.cornerCount, 4, 8))
  const byReversals = zigzag * Math.max(ramp(f.reversalDensity, RULES.scribbleRev[0], RULES.scribbleRev[1]), ramp(reversals, 2.5, 5))
  const byHairpins = ramp(ev.hairpins, RULES.hairpins[0], RULES.hairpins[1]) * (1 - ramp(ev.straightness, 0.5, 0.8))
  const byLoops = ramp(ev.loopsPerM, RULES.loopsPerM[0], RULES.loopsPerM[1]) * ramp(ev.inkDensity, RULES.inkDensity[0], RULES.inkDensity[1])
  // ink on a ring around its centre encloses (circle, revision cloud) rather than covers
  return clamp01(Math.max(byReversals, byHairpins, byLoops) * (1 - ev.ringness))
}

export interface RuleResult {
  scores: Record<DecisionKind, number>
  evidence: string[]
  /** Context item ids per kind (door host wall, delete targets). */
  targets: Partial<Record<DecisionKind, string[]>>
}

const ROOM_PRIORS: { re: RegExp; furniture: number }[] = [
  { re: /MEETING|CONFERENCE|OFFICE|OPEN|STUDIO|BED|LIVING|DINING/i, furniture: 1.1 },
  { re: /CORRIDOR|STAIR|LIFT|ELEV|SHAFT|RISER|LOBBY/i, furniture: 0.8 },
]

export function scoreKinds(ev: Evidence): RuleResult {
  const f = ev.f
  const evidence: string[] = []
  const targets: RuleResult['targets'] = {}
  const L = ev.lengthM
  const S = spanM(ev)
  const line = ev.fit.line?.score ?? 0
  const poly = ev.fit.polyline?.score ?? 0
  const arc = ev.fit.arc?.score ?? 0
  const rect = ev.fit.rectangle?.score ?? 0
  const blob = ev.fit.blob?.score ?? 0
  const scr = ev.fit.scribble?.score ?? 0
  const eraser = ev.stroke.tool === 'eraser'
  const ctx = ev.hasContext
  const cl = f.closureRatio

  const best = ev.best
  if (best) evidence.push(`best fit ${best.kind} ${best.score.toFixed(2)}, ${L.toFixed(2)} m${ev.scaleKnown ? '' : ' (scale assumed 1:100)'}`)
  if (!ctx) evidence.push('no sheet context (scanned or empty): shape only')

  const scribble = scribbleness(ev)
  if (scribble > 0.3) evidence.push(`scribble (${f.reversalDensity.toFixed(1)} reversals / 100 pt, ${ev.hairpins} hairpins, ${f.selfIntersections} loops)`)
  const thin = 1 - ramp(ev.aspect, RULES.thinAspect[0], RULES.thinAspect[1])
  // short perpendicular ticks at both ends of an open, straight-ish stroke: a dimension line
  const dimTicks = cl > 0.5 ? ev.endTicks : 0

  // ── wall: a straight line, or a clean polyline of long segments (not a dimension line) ──
  const straight = line * ramp(ev.straightness, 0.88, 0.96)
  const multi =
    ramp(poly, 0.5, 0.85) *
    (f.cornerCount >= 1 && f.cornerCount <= 4 ? 1 : 0.3) *
    ramp(ev.minSegPt / ev.ptPerM, 0.4, 0.9) *
    (dimTicks ? 0.15 : 1) *
    (ev.hairpins ? 0.2 : 1) * // walls do not double back
    ramp(cl, 0.2, 0.3)
  const wallShape = Math.max(straight, multi) * (1 - scribble)
  let wall = wallShape * ramp(L, RULES.wallLen[0], RULES.wallLen[1])
  const startSnap = ev.start.kind !== 'none'
  const endSnap = ev.end.kind !== 'none'
  if (ctx) {
    const ends = startSnap && endSnap ? 1 : startSnap || endSnap ? 0.35 : 0
    const aligned = ev.alignDiff !== undefined && ev.alignDiff < 6 * DEG ? 0.6 : 0
    const support = Math.max(ev.alongWall, ev.alongGrid, ends, aligned)
    const long = ramp(L, RULES.wallLongLen[0], RULES.wallLongLen[1])
    let k = Math.max(support, long, 0.3)
    if (ev.labelsNear.length && support < 0.5 && long < 0.5) k *= 0.5
    wall *= k
    if (ev.alongWall > 0.5) evidence.push(`runs along wall ${ev.alongWallId} (${Math.round(ev.alongWall * 100)}%)`)
    else if (ev.alongGrid > 0.5) evidence.push(`runs along a grid line (${Math.round(ev.alongGrid * 100)}%)`)
    if (startSnap || endSnap) evidence.push(`ends on ${[startSnap ? ev.start.kind : '', endSnap ? ev.end.kind : ''].filter(Boolean).join(' / ')}`)
  } else wall *= RULES.shapeOnlyFactor
  if (dimTicks && wallShape < 0.5) evidence.push('end ticks: dimension line')

  // ── door: a door-wide stroke through a wall (any shape: tick, slash, retrace), or a swing hanging off one ──
  const tickShape = thin * bump(S, ...RULES.doorSpan)
  const arcOnly = arc * bump(ev.straightness, ...RULES.doorArcStraightness) * bump(S, ...RULES.doorArcSpan) * (1 - scribble)
  // quarter arc plus leaf in one stroke: a square-ish, half-open outline about one door wide
  const sector =
    ramp(ev.aspect, 0.6, 0.75) * bump(S, 0.5, 0.6, 1.3, 1.5) * (1 - ramp(ev.straightness, 0.55, 0.7)) * bump(cl, 0.15, 0.25, 0.55, 0.7) * (1 - scribble) * 0.85
  const swingShape = Math.max(arcOnly, sector)
  let door: number
  if (ctx) {
    const c = ev.doorCross
    const crossS = c ? ramp(c.incidence, 40 * DEG, 65 * DEG) * (c.gapPt > 0 ? 0.9 : 1) : 0
    const tick = tickShape * crossS
    const snapHinge = ev.startWall.kind !== 'none' ? ev.startWall.itemIds[0] : ev.endWall.kind !== 'none' ? ev.endWall.itemIds[0] : undefined
    const hingeId = ev.touchWall?.itemId ?? snapHinge
    const swing = swingShape * (hingeId ? 1 : c ? 0.7 : 0)
    door = Math.max(tick, swing)
    if (tick >= swing && c && tick > 0.2) {
      targets.door = [c.itemId]
      evidence.push(`${S.toFixed(2)} m across ${c.gapPt > 0 ? 'the opening at ' : 'wall '}${c.itemId} at ${Math.round(c.incidence / DEG)}°`)
    } else if (swing > 0.2) {
      const host = hingeId ?? c?.itemId
      if (host) targets.door = [host]
      evidence.push(`swing beside ${host ?? 'a wall'}`)
    }
  } else door = Math.max(tickShape * line * 0.35, swingShape * 0.75)

  // ── furniture: a compact, closed or nearly closed shape (any outline) inside a room ──
  const closedness = 1 - ramp(cl, 0.12, 0.3)
  const compact = ramp(ev.aspect, 0.2, 0.32)
  const furnShape = Math.max(rect, arc, Math.min(1, blob * 1.6), 0.6) * closedness * compact * (1 - scribble)
  let furniture = furnShape * bump(S, ...RULES.furnitureSize)
  if (ctx) {
    if (ev.labelInside) {
      furniture *= 1 - 0.85 * ramp(ev.labelCover, 0.3, 0.45)
      evidence.push(`encloses label "${ev.labelInside.text}"`)
    }
    if (ev.room.label) {
      const prior = ROOM_PRIORS.find((r) => r.re.test(ev.room.label as string))
      if (prior) furniture *= prior.furniture
      if (furniture > 0.2) evidence.push(`inside room ${ev.room.label}`)
    } else furniture *= 0.85
  } else furniture *= 0.85

  // ── delete: eraser, or a scribble (zig-zag, loops, or wiggling along a wall) over a detected item ──
  let del: number
  if (ctx) {
    const fx = ev.fixturesOver.filter((x) => x.overlap >= 0.5)
    const wl = ev.wallsOver.filter((w) => w.near >= 0.3)
    let target = 0
    if (fx.length) {
      target = 1
      targets.delete = fx.map((x) => x.item.id)
    } else if (wl.length) {
      target = ramp(wl[0].near, 0.3, 0.6) * 0.5 + 0.5
      targets.delete = [wl[0].item.id]
    }
    // ink going back and forth along a wall that is neither a line nor a clean polyline
    const wiggle = (1 - Math.max(line, poly)) * ramp(ev.alongWall, 0.5, 0.8) * thin * ramp(L, 1.5, 2.5)
    const sc = Math.max(scribble ** RULES.deleteScribblePow, wiggle)
    del = eraser ? 0.6 + 0.35 * target : sc * target
    if (targets.delete && del > 0.2) evidence.push(`${eraser ? 'eraser' : 'scribble'} over ${targets.delete.join(', ')}`)
  } else del = eraser ? 0.8 : scribble * 0.75 * ramp(ev.aspect, 0.25, 0.4)
  if (eraser) evidence.push('eraser tool')

  // ── markup ──
  let markup = RULES.markupBase
  if (ctx && ev.labelInside) markup += 0.5 * ramp(ev.labelCover, 0.3, 0.45)
  else if (ctx && cl > 0.2 && L < 3 && ev.labelsNear.length && ev.alongWall < 0.5 && ev.alongGrid < 0.5) {
    markup += 0.2
    evidence.push(`next to label "${ev.labelsNear[0].text}"`)
  }
  markup += 0.5 * scribble * (targets.delete || (!ctx && del > 0.3) ? 0 : 1)
  if (cl < 0.2) markup += 0.5 * ramp(S, 2.6, 3.4)
  if (!eraser && scr > 0.3 && scribble < 0.3) markup += 0.3 * scr // arrows, cursive
  if (f.selfIntersections >= 2 && scribble < 0.5 && cl > 0.2) markup += 0.2
  if (dimTicks && wallShape < 0.5) markup += 0.3
  // a big ring (revision cloud, circling) encloses things; furniture is smaller
  if (cl < 0.2) markup += 0.5 * ev.ringness * ramp(S, 2.2, 2.8)

  return {
    scores: { wall, door, furniture, delete: del, markup },
    evidence,
    targets,
  }
}
