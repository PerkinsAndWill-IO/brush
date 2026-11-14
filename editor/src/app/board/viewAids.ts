/**
 * View aids ported from the chSpace viewer (docs/tasks/V1-view-aids.md): graphic
 * scale bar, real-unit measurements and a metric grid. PURE: no DOM, no React —
 * unit tested in tests/unit/app-view-aids.test.ts.
 *
 * All of them need the sheet scale (100 for 1:100). Sheet units are PDF points;
 * screen px per point is the camera zoom z.
 */
import type { Point } from '@core/types'
import { ptPerMetre } from '@core/context'

/** 1-2-5 series: 0.001 m … 5000 m. */
const NICE: number[] = []
for (let e = -3; e <= 3; e++) for (const m of [1, 2, 5]) NICE.push(m * 10 ** e)

/** Format a real length: mm below 1 m, metres with 2 decimals below 10 m, 1 decimal above. */
export function formatMetres(m: number): string {
  if (!Number.isFinite(m)) return '–'
  const a = Math.abs(m)
  if (a < 1) return `${Math.round(m * 1000)} mm`
  if (a < 10) return `${m.toFixed(2)} m`
  return `${m.toFixed(1)} m`
}

/** Short label for a round bar length: "500 mm", "2 m", "1 km". */
function roundLabel(m: number): string {
  if (m < 1) return `${Math.round(m * 1000)} mm`
  if (m >= 1000) return `${m / 1000} km`
  return `${m} m`
}

export interface ScaleBar {
  /** Real length the whole bar stands for, metres. */
  metres: number
  /** Bar width on screen, CSS px. */
  px: number
  /** Tick labels at 0, half and full length. */
  labels: [string, string, string]
}

/**
 * Graphic scale for zoom `z` on a sheet at 1:`scale`: the longest 1-2-5 length
 * whose bar fits in `maxPx`. Null when the scale is unknown or nothing fits.
 */
export function scaleBarFor(z: number, scale: number | undefined, maxPx = 160, minPx = 40): ScaleBar | null {
  if (!scale || scale <= 0 || !(z > 0)) return null
  const pxPerMetre = z * ptPerMetre(scale)
  let best: number | null = null
  for (const m of NICE) {
    const px = m * pxPerMetre
    if (px <= maxPx && px >= minPx) best = m
  }
  if (best === null) return null
  const full = roundLabel(best)
  const half = roundLabel(best / 2)
  // "0 · 1 · 2 m": the middle tick drops its unit when it shares the end's unit
  const unit = (s: string) => s.split(' ')[1]
  const mid = unit(half) === unit(full) ? half.split(' ')[0] : half
  return { metres: best, px: best * pxPerMetre, labels: ['0', mid, full] }
}

/** Distance between two sheet points in metres at 1:`scale`. */
export function sheetDistanceMetres(a: Point, b: Point, scale: number): number {
  return Math.hypot(b.x - a.x, b.y - a.y) / ptPerMetre(scale)
}

export interface GridSpacing {
  /** Minor and major spacing in metres. */
  minorM: number
  majorM: number
  /** Minor and major spacing in sheet points. */
  minorPt: number
  majorPt: number
}

/**
 * Metric grid for a sheet at 1:`scale` seen at zoom `z`: minor lines at the
 * smallest of 0.1 / 0.5 / 1 / 5 / 10 / 50 / 100 m that is at least `minPx`
 * apart on screen, majors every 5 minors (1 m → 5 m, 0.5 m → 2.5 m…).
 * Also never more than `maxLines` minor lines across the longer sheet side.
 */
export function gridSpacingFor(z: number, scale: number | undefined, sheetMaxPt: number, minPx = 10, maxLines = 400): GridSpacing | null {
  if (!scale || scale <= 0 || !(z > 0)) return null
  const ptm = ptPerMetre(scale)
  for (const m of [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000]) {
    const pt = m * ptm
    if (pt * z >= minPx && sheetMaxPt / pt <= maxLines) return { minorM: m, majorM: m * 5, minorPt: pt, majorPt: pt * 5 }
  }
  return null
}

/** Offsets 0, step, 2·step … ≤ length (grid line positions along one axis). */
export function gridLines(length: number, step: number): number[] {
  if (!(step > 0) || !(length > 0)) return []
  const out: number[] = []
  for (let i = 0, v = 0; v <= length + 1e-6; v = ++i * step) out.push(v)
  return out
}
