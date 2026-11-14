import type { Path, Point, Rect, Stroke, StrokePoint, StrokeTool } from '../types'
import { bbox, closestPointOnPolyline, polylineLength } from '../geometry/vec'

export interface CreateStrokeOptions {
  tool?: StrokeTool
  size?: number
  color?: string
  startedAt?: number
  points?: StrokePoint[]
}

export function createStroke(id: string, sheetId: string, opts: CreateStrokeOptions = {}): Stroke {
  const s: Stroke = {
    id,
    sheetId,
    points: opts.points ? opts.points.slice() : [],
    tool: opts.tool ?? 'brush',
    size: opts.size ?? 2,
  }
  if (opts.color !== undefined) s.color = opts.color
  if (opts.startedAt !== undefined) s.startedAt = opts.startedAt
  return s
}

/**
 * Append a point in place (the hot path while drawing). The first point is
 * forced to t = 0 and time never goes backwards. Returns the same stroke.
 */
export function appendPoint(stroke: Stroke, p: StrokePoint): Stroke {
  const n = stroke.points.length
  const t = n === 0 ? 0 : Math.max(p.t, stroke.points[n - 1].t)
  const q: StrokePoint = { x: p.x, y: p.y, t }
  if (p.p !== undefined) q.p = p.p
  stroke.points.push(q)
  return stroke
}

export function appendPoints(stroke: Stroke, pts: readonly StrokePoint[]): Stroke {
  for (const p of pts) appendPoint(stroke, p)
  return stroke
}

/** Immutable variant: returns a new stroke with the point appended. */
export function withPoint(stroke: Stroke, p: StrokePoint): Stroke {
  return appendPoint({ ...stroke, points: stroke.points.slice() }, p)
}

export const strokeDurationMs = (s: Stroke): number =>
  s.points.length < 2 ? 0 : s.points[s.points.length - 1].t - s.points[0].t

export const strokeLengthPt = (s: Stroke): number => polylineLength(s.points)

export const strokeBBox = (s: Stroke): Rect => bbox(s.points)

export const strokePath = (s: Stroke): Path => ({ points: s.points.map((p) => ({ x: p.x, y: p.y })), closed: false })

export interface GroupOptions {
  /** Max idle time between the end of one stroke and the start of the next. Default 600 ms. */
  maxGapMs?: number
  /** Max distance between the two strokes' geometry, in sheet points. Default 40. */
  maxDistPt?: number
}

function sample(pts: readonly Point[], max = 48): Point[] {
  if (pts.length <= max) return pts as Point[]
  const out: Point[] = []
  for (let i = 0; i < max; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (max - 1))])
  return out
}

/** Approximate minimum distance between two strokes' polylines. */
export function strokeDistance(a: Stroke, b: Stroke): number {
  if (a.points.length === 0 || b.points.length === 0) return Infinity
  let m = Infinity
  for (const p of sample(a.points)) m = Math.min(m, closestPointOnPolyline(p, b.points).distance)
  for (const p of sample(b.points)) m = Math.min(m, closestPointOnPolyline(p, a.points).distance)
  return m
}

/**
 * Group strokes that read as one gesture: same sheet, started soon after the
 * previous one ended, and drawn close to it (or to any stroke already in the
 * group). Strokes are processed in array order (chronological). When
 * startedAt is missing the time gap is treated as 0, so only distance counts.
 */
export function groupStrokes(strokes: readonly Stroke[], opts: GroupOptions = {}): Stroke[][] {
  const maxGap = opts.maxGapMs ?? 600
  const maxDist = opts.maxDistPt ?? 40
  const groups: Stroke[][] = []
  let cur: Stroke[] = []
  for (const s of strokes) {
    if (cur.length === 0) {
      cur = [s]
      continue
    }
    const prev = cur[cur.length - 1]
    let gap = 0
    if (s.startedAt !== undefined && prev.startedAt !== undefined) {
      gap = s.startedAt - (prev.startedAt + strokeDurationMs(prev))
    }
    let ok = s.sheetId === prev.sheetId && gap <= maxGap
    if (ok) ok = cur.some((g) => strokeDistance(g, s) <= maxDist)
    if (ok) cur.push(s)
    else {
      groups.push(cur)
      cur = [s]
    }
  }
  if (cur.length) groups.push(cur)
  return groups
}
