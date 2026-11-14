import type { DecisionKind } from '../types'
import type { Evidence } from './evidence'

/**
 * Rule-based scoring, one rule per decision kind (docs/spec.md "Decision vocabulary").
 * Every rule returns a raw score in 0..1 plus evidence lines for the Reading panel.
 * Raw scores are normalised into confidences in predictor.ts.
 *
 * Tuned on the train split only (`pnpm eval --split=train`); held-out strokes never.
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

/** Weights and thresholds, in one place so tuning is visible. */
export const RULES = {
  /** Strokes shorter than this (metres) are too early to read. */
  minLengthM: 0.25,
  scribbleRev: [0.8, 2.0] as const,
  wallLen: [0.8, 1.6] as const,
  wallLongLen: [3, 5] as const,
  doorTickLen: [0.5, 0.7, 1.35, 1.7] as const,
  doorArcLen: [0.8, 1.05, 1.85, 2.3] as const,
  doorArcStraightness: [0.7, 0.8, 0.95, 0.98] as const,
  furnitureSize: [0.3, 0.45, 2.2, 2.9] as const,
  markupBase: 0.22,
  shapeOnlyFactor: 0.8,
}

/** Coarse class, refinement step 1. */
export function coarseOf(ev: Evidence): Coarse {
  const f = ev.f
  if (ev.stroke.tool === 'eraser') return 'unknown'
  if (ev.lengthM < RULES.minLengthM || f.fits.length === 0) return 'unknown'
  const scr = ev.fit.scribble?.score ?? 0
  if (scr >= 0.5 && f.reversalDensity >= RULES.scribbleRev[0]) return 'unknown'
  if (f.closed || (f.closureRatio < 0.2 && f.cornerCount >= 3)) return 'closed'
  return 'linear'
}

export interface RuleResult {
  scores: Record<DecisionKind, number>
  evidence: string[]
  /** Context item ids per kind (door host wall, delete targets). */
  targets: Partial<Record<DecisionKind, string[]>>
}

const ROOM_PRIORS: { re: RegExp; furniture: number }[] = [
  { re: /MEETING|CONFERENCE|OFFICE|OPEN|STUDIO|BED|LIVING|DINING/i, furniture: 1.1 },
  { re: /CORRIDOR|STAIR|LIFT|ELEV|SHAFT|RISER|LOBBY/i, furniture: 0.6 },
]

export function scoreKinds(ev: Evidence): RuleResult {
  const f = ev.f
  const evidence: string[] = []
  const targets: RuleResult['targets'] = {}
  const L = ev.lengthM
  const line = ev.fit.line?.score ?? 0
  const poly = ev.fit.polyline?.score ?? 0
  const arc = ev.fit.arc?.score ?? 0
  const rect = ev.fit.rectangle?.score ?? 0
  const blob = ev.fit.blob?.score ?? 0
  const scr = ev.fit.scribble?.score ?? 0
  const eraser = ev.stroke.tool === 'eraser'
  const ctx = ev.hasContext
  const maxDimM = Math.max(ev.bboxM.w, ev.bboxM.h)

  const best = ev.best
  if (best) evidence.push(`best fit ${best.kind} ${best.score.toFixed(2)}, ${L.toFixed(2)} m${ev.scaleKnown ? '' : ' (scale assumed 1:100)'}`)
  if (!ctx) evidence.push('no sheet context (scanned or empty): shape only')

  // scribble-ness: a zig-zag (scribble fit or many corners) with many reversals, dense or long
  const reversals = (f.reversalDensity * f.lengthPt) / 100
  const zigzag = Math.max(scr, ramp(f.cornerCount, 4, 8))
  const scribble = clamp01(zigzag * Math.max(ramp(f.reversalDensity, RULES.scribbleRev[0], RULES.scribbleRev[1]), ramp(reversals, 2.5, 5)))
  if (scribble > 0.3) evidence.push(`scribble (${f.reversalDensity.toFixed(1)} reversals / 100 pt)`)

  // ── wall ──
  const straight = line * ramp(ev.straightness, 0.88, 0.96)
  const lshape = poly * (f.cornerCount >= 1 && f.cornerCount <= 3 ? 1 : 0.3) * ramp(ev.straightness, 0.4, 0.6)
  const wallShape = Math.max(straight, lshape) * (1 - scribble)
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

  // ── door ──
  let door: number
  const tickShape = Math.max(line, arc) * ramp(ev.straightness, 0.9, 0.96) * bump(L, ...RULES.doorTickLen) * (1 - scribble)
  const arcShape =
    arc * bump(ev.straightness, ...RULES.doorArcStraightness) * bump(L, ...RULES.doorArcLen) * (f.closed ? 0 : 1) * (1 - scribble)
  if (ctx) {
    const mid = ev.crossings
      .filter((c) => c.u > 0.15 && c.u < 0.85)
      .map((c) => ({ c, s: ramp(c.incidence, 45 * DEG, 70 * DEG) }))
      .sort((a, b) => b.s - a.s)
    const cross = mid[0]
    // a stroke lying on a wall/grid is a short wall, not a tick through one
    const tick = tickShape * (cross ? cross.s : 0) * (1 - ramp(Math.max(ev.alongWall, ev.alongGrid), 0.6, 0.9))
    const sw = ev.startWall.kind !== 'none'
    const ew = ev.endWall.kind !== 'none'
    const nearWall = sw || ew ? 1 : ev.crossings.length ? 0.7 : 0
    const swing = arcShape * nearWall
    door = Math.max(tick, swing)
    if (tick >= swing && cross && tick > 0.2) {
      targets.door = [cross.c.itemId]
      evidence.push(`crosses wall ${cross.c.itemId} at ${Math.round(cross.c.incidence / DEG)}°`)
    } else if (swing > 0.2) {
      const host = sw ? ev.startWall.itemIds : ew ? ev.endWall.itemIds : ev.crossings.map((c) => c.itemId)
      if (host.length) targets.door = [host[0]]
      evidence.push(`swing arc beside ${host[0] ?? 'a wall'}`)
    }
  } else door = Math.max(tickShape * 0.4, arcShape * 0.75)

  // ── furniture ──
  const closedness = 1 - ramp(f.closureRatio, 0.1, 0.22)
  const furnShape = Math.max(rect, arc, Math.min(1, blob * 1.6), 0.45) * closedness * (1 - scribble)
  let furniture = furnShape * bump(maxDimM, ...RULES.furnitureSize)
  if (ctx) {
    if (ev.labelInside) {
      furniture *= 1 - 0.85 * ramp(ev.labelCover, 0.3, 0.45)
      evidence.push(`encloses label "${ev.labelInside.text}"`)
    }
    if (ev.room.label) {
      const prior = ROOM_PRIORS.find((r) => r.re.test(ev.room.label as string))
      if (prior) furniture *= prior.furniture
      if (furniture > 0.2) evidence.push(`inside room ${ev.room.label}`)
    } else furniture *= 0.75
  } else furniture *= 0.85

  // ── delete ──
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
    del = eraser ? 0.6 + 0.35 * target : scribble ** 1.5 * target
    if (targets.delete && del > 0.2) evidence.push(`${eraser ? 'eraser' : 'scribble'} over ${targets.delete.join(', ')}`)
  } else del = eraser ? 0.8 : scribble * 0.35
  if (eraser) evidence.push('eraser tool')

  // ── markup ──
  let markup = RULES.markupBase
  if (ctx && ev.labelInside) markup += 0.5 * ramp(ev.labelCover, 0.3, 0.45)
  else if (ctx && !f.closed && ev.labelsNear.length && ev.alongWall < 0.5 && ev.alongGrid < 0.5) {
    markup += 0.2
    evidence.push(`next to label "${ev.labelsNear[0].text}"`)
  }
  markup += 0.5 * scribble * (del > 0.3 ? 0 : 1)
  if (f.closed) markup += 0.5 * ramp(maxDimM, 2.6, 3.4)
  if (!eraser && scr > 0.3 && scribble < 0.3) markup += 0.3 * scr // arrows, cursive
  if (f.selfIntersections >= 2 && scribble < 0.5 && !f.closed) markup += 0.2

  return {
    scores: { wall, door, furniture, delete: del, markup },
    evidence,
    targets,
  }
}
