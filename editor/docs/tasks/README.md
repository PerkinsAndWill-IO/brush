# Tasks

One file per milestone. Each lists requirement IDs and the acceptance test that proves each one.
Spec: `../spec.md`. Budgets: `../../scripts/budgets.ts`. Done = `pnpm verify` green (AGENTS.md).

IDs for M1 are the spec's own. M2–M5 IDs were derived here from the spec's exit criteria, context
signals, engine rules and budget table; a human may renumber them.

| File | Milestone |
|---|---|
| [M1-sketch-on-pdf.md](M1-sketch-on-pdf.md) | Sketch on PDF |
| [M2-context.md](M2-context.md) | Context |
| [M3-streaming-prediction.md](M3-streaming-prediction.md) | Streaming prediction |
| [M4-model-second-pass.md](M4-model-second-pass.md) | Model second pass |
| [M5-commands-and-packages.md](M5-commands-and-packages.md) | Commands and packages |
| [M6-revit-link.md](M6-revit-link.md) | Live link to Revit (plugin side in `revit/`) |
| [V1-view-aids.md](V1-view-aids.md) | View aids from the chSpace viewer (scale bar, measure, grid, label size) |
| [V2-drawing-filters.md](V2-drawing-filters.md) | Display filters for `.drawing` pages (categories, item kinds) |
| [P1-photo-import.md](P1-photo-import.md) | Import pen and marker markup from a photo of a printed sheet, as brush strokes |
| [V3-inspect.md](V3-inspect.md) | Inspect elements: hover highlights on every sheet, click pins the data card |
| [eval-entry.md](eval-entry.md) | How a predictor plugs into `pnpm eval` |

To change a test, budget or threshold: add a "Proposed change" section to the task file and wait for a human (rule 3).
