/**
 * Plug-in point for `pnpm eval` (docs/tasks/eval-entry.md).
 * One StreamingPredictor per recording; the harness calls `update` on its
 * refresh cadence and `flush` (when present) on the last point.
 */
import type { BrushSettings, Predictor } from '../types'
import { PREDICTOR_NAME, StreamingPredictor } from './predictor'

export const predictorName: string = PREDICTOR_NAME

export function createPredictor(): Predictor {
  return new StreamingPredictor()
}

/** Defaults from DEFAULT_BRUSH_SETTINGS; no overrides. */
export const settings: Partial<BrushSettings> = {}
