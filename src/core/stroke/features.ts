import type { Point, Stroke, StrokeFeatures } from '../types'
import { analyzePrepared, prepareForFit, CLOSED_RATIO } from '../geometry/fit'
import { bbox, dist, polylineLength, segmentIntersection } from '../geometry/vec'

export interface FeatureOptions {
  /** Sheet scale, 100 for 1:100. Enables lengthM / bboxM. */
  scale?: number
  /** 0..1 pre-smoothing applied before fitting. Default 0. */
  smoothing?: number
}

/** Metres in the real world for `pt` sheet points at the given scale: pt / 72 in * 25.4 mm * scale. */
export const ptToMetres = (pt: number, scale: number): number => (pt / 72) * 0.0254 * scale

export const PROFILE_SAMPLES = 16

function resampleSeries(v: readonly number[], n: number): number[] {
  if (v.length === 0) return []
  if (v.length === 1) return new Array<number>(n).fill(v[0])
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const f = (i * (v.length - 1)) / (n - 1)
    const i0 = Math.floor(f)
    const i1 = Math.min(v.length - 1, i0 + 1)
    out.push(v[i0] + (v[i1] - v[i0]) * (f - i0))
  }
  return out
}

function countSelfIntersections(pts: readonly Point[], closed: boolean): number {
  const n = pts.length - 1
  let c = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (closed && i === 0 && j === n - 1) continue
      if (segmentIntersection(pts[i], pts[i + 1], pts[j], pts[j + 1])) c++
    }
  }
  return c
}

/**
 * Geometry, timing and primitive-fit features of a stroke (recomputed from
 * scratch; ~0.2 ms for 300 points, fast enough for every 50 ms refresh).
 */
export function extractFeatures(stroke: Stroke, opts: FeatureOptions = {}): StrokeFeatures {
  const sp = stroke.points
  const lengthPt = polylineLength(sp)
  const bb = bbox(sp)
  const closureRatio = sp.length < 2 || lengthPt < 1e-9 ? 0 : dist(sp[0], sp[sp.length - 1]) / lengthPt
  const closed = sp.length >= 3 && lengthPt > 1e-9 && closureRatio < CLOSED_RATIO
  const durationMs = sp.length < 2 ? 0 : Math.max(0, sp[sp.length - 1].t - sp[0].t)

  // speed profile: per-segment speed, skipping zero-dt segments by carrying the previous value
  const speeds: number[] = []
  let lastSpeed = 0
  for (let i = 1; i < sp.length; i++) {
    const dt = sp[i].t - sp[i - 1].t
    if (dt > 0) lastSpeed = dist(sp[i - 1], sp[i]) / dt
    speeds.push(lastSpeed)
  }
  const speedProfile = resampleSeries(speeds, PROFILE_SAMPLES)

  let pressureProfile: number[] = []
  if (sp.length > 0 && sp.every((p) => p.p !== undefined)) {
    pressureProfile = resampleSeries(
      sp.map((p) => p.p as number),
      PROFILE_SAMPLES,
    )
  }

  let fits: StrokeFeatures['fits'] = []
  let cornerCount = 0
  let selfIntersections = 0
  let reversals = 0
  const prep = prepareForFit(sp, opts.smoothing ?? 0)
  if (prep) {
    const a = analyzePrepared(prep)
    fits = a.fits
    cornerCount = a.corners
    reversals = a.reversals
    selfIntersections = countSelfIntersections(prep.pts, prep.closed)
  }

  const f: StrokeFeatures = {
    fits,
    lengthPt,
    bbox: bb,
    closureRatio,
    closed,
    cornerCount,
    selfIntersections,
    durationMs,
    meanSpeed: durationMs > 0 ? lengthPt / durationMs : 0,
    speedProfile,
    pressureProfile,
    // reversals per 100 pt of stroke length
    reversalDensity: lengthPt > 1e-9 ? (reversals / lengthPt) * 100 : 0,
  }
  if (opts.scale !== undefined && opts.scale > 0) {
    f.lengthM = ptToMetres(lengthPt, opts.scale)
    f.bboxM = { w: ptToMetres(bb.w, opts.scale), h: ptToMetres(bb.h, opts.scale) }
  }
  return f
}
