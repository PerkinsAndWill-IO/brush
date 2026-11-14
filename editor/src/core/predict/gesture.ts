import type { BrushSettings, Hypothesis, SheetContext, Stroke, StrokePoint } from '../types'
import { groupStrokes, strokeDurationMs, type GroupOptions } from '../stroke'
import { StreamingPredictor, type PredictorOptions } from './predictor'

export { groupStrokes }
export type { GroupOptions }

/**
 * Gesture grouping (M3-11): strokes close in time and space read together,
 * e.g. the two strokes of an X scribble. The strokes of a group are joined into
 * one stroke (points in order, times shifted by each stroke's start) so the
 * first pass sees the whole gesture.
 */
export function mergeGesture(strokes: readonly Stroke[]): Stroke {
  if (!strokes.length) throw new Error('mergeGesture: empty group')
  const first = strokes[0]
  const points: StrokePoint[] = []
  let offset = 0
  strokes.forEach((s, i) => {
    if (i > 0) {
      const prev = strokes[i - 1]
      const gap =
        s.startedAt !== undefined && prev.startedAt !== undefined ? Math.max(0, s.startedAt - (prev.startedAt + strokeDurationMs(prev))) : 0
      offset = (points.length ? points[points.length - 1].t : 0) + gap
    }
    const t0 = s.points[0]?.t ?? 0
    for (const p of s.points) points.push({ ...p, t: offset + (p.t - t0) })
  })
  const merged: Stroke = {
    id: strokes.map((s) => s.id).join('+'),
    sheetId: first.sheetId,
    points,
    // an eraser anywhere in the gesture makes it an erase gesture
    tool: strokes.some((s) => s.tool === 'eraser') ? 'eraser' : first.tool,
    size: first.size,
  }
  if (first.color !== undefined) merged.color = first.color
  if (first.startedAt !== undefined) merged.startedAt = first.startedAt
  return merged
}

/** Read a finished group of strokes as one gesture: replay it on the refresh cadence, return the final hypothesis. */
export function readGesture(strokes: readonly Stroke[], ctx: SheetContext, settings: BrushSettings, opts?: PredictorOptions): Hypothesis {
  const merged = mergeGesture(strokes)
  const p = new StreamingPredictor(opts)
  const acc: Stroke = { ...merged, points: [] }
  for (const pt of merged.points) {
    acc.points.push(pt)
    p.update({ ...acc, points: acc.points.slice() }, ctx, settings)
  }
  return p.flush(merged, ctx, settings)
}

/** Group a chronological list of strokes and read each multi-stroke group as one gesture. */
export function readGestures(
  strokes: readonly Stroke[],
  ctx: SheetContext,
  settings: BrushSettings,
  opts?: PredictorOptions & { group?: GroupOptions },
): { strokes: Stroke[]; hypothesis: Hypothesis }[] {
  return groupStrokes(strokes, opts?.group).map((g) => ({ strokes: g, hypothesis: readGesture(g, ctx, settings, opts) }))
}
