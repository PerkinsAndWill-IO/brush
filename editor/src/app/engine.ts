/**
 * BrushEngine hooks: the extension point where M3 plugs a Predictor into the
 * live stroke. The board calls these with the in-progress stroke in SHEET
 * coordinates (PDF points), on the same path the ink takes. Hooks must be
 * fast and must not throw; errors are caught so ink never breaks.
 */
import type { Sheet, Stroke } from '@core/types'

export interface BrushEngine {
  /** Pen down on a sheet; the stroke has its first point. `downTs` is the pointer event time (performance.now clock). */
  onStrokeStart?(stroke: Readonly<Stroke>, sheet: Sheet, info: { downTs: number }): void
  /** New points arrived (called at most once per animation frame). */
  onStrokeUpdate?(stroke: Readonly<Stroke>, sheet: Sheet): void
  /** Pen up. `committed` is false when the stroke was cancelled (e.g. a pinch started). */
  onStrokeEnd?(stroke: Readonly<Stroke>, sheet: Sheet, info: { committed: boolean }): void
}

const engines = new Set<BrushEngine>()

export function registerBrushEngine(engine: BrushEngine): () => void {
  engines.add(engine)
  return () => engines.delete(engine)
}

type Hook = keyof BrushEngine
export function callEngines<K extends Hook>(hook: K, ...args: Parameters<NonNullable<BrushEngine[K]>>) {
  for (const e of engines) {
    const fn = e[hook] as ((...a: unknown[]) => void) | undefined
    if (!fn) continue
    try {
      fn.apply(e, args)
    } catch (err) {
      console.error(`BrushEngine.${hook} failed`, err)
    }
  }
}
