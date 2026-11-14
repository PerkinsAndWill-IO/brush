# 0001 Freeze core/types

Date: 2026-11-14

The lead froze `src/core/types/index.ts` before parallel lanes started, per the spec ("A human freezes core/types before the parallel lanes begin").

Additions beyond the spec's sketch, and why:
- `Point`, `Path`, `Rect`: the spec references `Path` without defining it.
- `Sheet.pageIndex`: needed to map sheets back to PDF pages.
- `RawPageContent`: the app extracts PDF content with pdf.js and hands it to `core/context` as plain data, keeping core free of pdf.js.
- `StrokeFeatures`, `PrimitiveFit`: shared between `core/stroke` and `core/predict`.
- `BrushSettings` with spec thresholds as defaults.
- `Command` union: `create_wall`, `place_door`, `place_instance`, `delete`.
- `BrushTestApi` adds `camera`, `contextFor`, `undo`, `redo`, `setTool` for E2E assertions.

Coordinates are PDF points with origin top-left and y down.
