# Plugging a predictor into `pnpm eval`

`tests/eval/run-eval.ts` (harness lane) owns replay, timing and scoring. The predict lane only provides
**`src/core/predict/eval-entry.ts`**:

```ts
import type { BrushSettings, Predictor } from '../types'

/** Shown in the eval report. */
export const predictorName: string = 'rules-v1'

/** Fresh, stateful-per-stroke predictor. Called once per recording. */
export function createPredictor(): Predictor { /* ... */ }

/** Optional overrides merged over DEFAULT_BRUSH_SETTINGS. */
export const settings: Partial<BrushSettings> = {}
```

If the file is missing, or has no `createPredictor`, eval prints "no predictor yet" and every eval budget stays `pending (M3)`.

## What the harness does per recording

1. Loads every `fixtures/strokes/**/*.json` (a `StrokeRecording` or an array of them; `index.json` and `manifest.json` are skipped).
2. Context: `fixtures/contexts/<pdf-basename>.<sheet>.json` (a `SheetContext`) if it exists, otherwise
   `{ sheetId, origin: 'inferred', items: [], shapeOnly: true }`. Whoever can build contexts headlessly
   (context + fixtures lanes) should write those files. `sheetId` is `sheet-<pageIndex>`, matching the app.
3. Builds a `Stroke` point by point and calls `predictor.update(stroke, ctx, settings)` on the first point,
   then whenever recorded time advanced by at least `settings.refreshMs`, and on the last point (the committed hypothesis).
   Replays run as fast as possible; `performance.now()` is taken around each `update` call.
4. Scores: top-1 (final kind vs `label.kind`; on `split: "heldout"` only, when held-out recordings exist),
   wrong element committed (final kind is not markup and not the label), leading-kind flips per stroke,
   first-hypothesis and per-update latency percentiles, a confusion table and per-kind accuracy.

## Output: `reports/eval.json`

```jsonc
{
  "predictor": "rules-v1",            // null when there is no entry
  "corpus": { "total": 250, "heldout": 50, "byKind": { "wall": 50 }, "skippedFiles": [] },
  "metrics": {                        // numeric keys gated by scripts/budgets.ts (source: 'eval')
    "top1Accuracy": 0.0, "wrongElementRate": 0.0, "flipsPerStrokeMean": 0.0,
    "firstHypothesisP95Ms": 0.0, "firstHypothesisP50Ms": 0.0, "updateP95Ms": 0.0, "updateMaxMs": 0.0,
    "top1Basis": "heldout"
  },
  "confusion": { "wall": { "wall": 0, "door": 0 } },
  "perKind": { "wall": { "n": 50, "accuracy": 0.0 } },
  "strokes": [{ "file": "", "label": "wall", "predicted": "wall", "split": "train", "flips": 0, "runs": 0, "firstMs": 0 }]
}
```

Try an alternative predictor without touching the default entry: `BRUSH_EVAL_ENTRY=path/to/entry.ts pnpm eval`
(the harness was checked this way with a dummy predictor: metrics, confusion and budget gates all populate).
