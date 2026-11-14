/**
 * Traced markup -> session strokes. PURE: no DOM, no OpenCV (types only), so the main thread and unit tests can use it.
 *
 * A traced stroke is a simplified centreline with a pen width. A session stroke is a list of pen samples, and the
 * board smooths it with a moving average over samples, so the centreline is resampled to an even spacing first
 * (sparse vertices would have their corners cut). Timestamps are made up from the length at a steady pen speed.
 */
import type { Stroke, StrokePoint } from '@core/types'
import type { MarkupLayer } from './pipeline'

export interface ToStrokesOptions {
  sheetId: string
  /** Stroke ids are `<idPrefix><n>`; must be unique in the session. */
  idPrefix: string
  /** Epoch ms for `startedAt` (session-history grouping). */
  startedAt: number
  /** Largest gap between samples, sheet points. */
  spacingPt?: number
  /** Assumed pen speed, sheet points per ms. */
  speedPtPerMs?: number
}

export const rgbToHex = (c: readonly number[]): string =>
  '#' +
  c
    .slice(0, 3)
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')

const r2 = (v: number) => Math.round(v * 100) / 100

/** Even samples along a polyline; every original vertex is kept. */
export function resampleCentreline(points: readonly (readonly [number, number])[], closed: boolean, spacingPt: number, speedPtPerMs: number): StrokePoint[] {
  const src = closed && points.length > 2 ? [...points, points[0]] : points
  const out: StrokePoint[] = []
  let length = 0
  for (let i = 0; i < src.length; i++) {
    const [x, y] = src[i]
    if (i > 0) {
      const [px, py] = src[i - 1]
      const seg = Math.hypot(x - px, y - py)
      const steps = Math.max(1, Math.ceil(seg / spacingPt))
      for (let k = 1; k < steps; k++) {
        const f = k / steps
        out.push({ x: r2(px + (x - px) * f), y: r2(py + (y - py) * f), t: Math.round((length + seg * f) / speedPtPerMs) })
      }
      length += seg
    }
    out.push({ x: r2(x), y: r2(y), t: Math.round(length / speedPtPerMs) })
  }
  return out
}

/** One brush stroke per traced stroke, in the layer's ink colour and pen width. */
export function markupToStrokes(layers: readonly MarkupLayer[], opts: ToStrokesOptions): Stroke[] {
  const { sheetId, idPrefix, startedAt, spacingPt = 2, speedPtPerMs = 0.5 } = opts
  const strokes: Stroke[] = []
  for (const layer of layers) {
    const color = rgbToHex(layer.color)
    for (const s of layer.strokes) {
      if (!s.points.length) continue
      strokes.push({
        id: `${idPrefix}${strokes.length}`,
        sheetId,
        points: resampleCentreline(s.points, s.closed, spacingPt, speedPtPerMs),
        tool: 'brush',
        size: Math.max(0.5, r2(s.width)),
        color,
        startedAt,
      })
    }
  }
  return strokes
}
