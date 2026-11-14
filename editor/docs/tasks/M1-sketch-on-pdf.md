# M1 — Sketch on PDF

**Goal:** a fast, dependable sketching surface over PDF sheets. No snapping, no ghost, no prediction.
**Exit:** a replayed stroke lands on the right sheet, survives zoom and reload, can be erased and undone. Ink latency within budget. Nothing is predicted.
**Lane:** Canvas (app). Core pieces (sheet-coordinate transform for M1-07) may go to Stroke core.

| ID | Requirement | Acceptance test |
|---|---|---|
| M1-01 | With no file open, show the empty state with a drop zone and a Choose file button. | Screenshot test of the empty state (`reports/screens/m1-01-empty.png`) |
| M1-02 | Dropping or choosing a PDF opens it. A non-PDF or unreadable file shows an inline error and keeps the empty state. | E2E with `office-1-sheet.pdf` and `corrupt.pdf` / `not-a-pdf.txt` |
| M1-03 | Every page becomes a sheet on one board, laid out in a grid, each with its name above it. | E2E counts sheets and checks labels on `office-6-sheets.pdf` |
| M1-04 | Pan with the Pan tool, space-drag, two-finger scroll. Zoom with pinch and Ctrl-scroll, centered on the pointer. | E2E checks `camera()` after scripted input |
| M1-05 | Sheets stay sharp when zoomed: pages re-render at the new resolution after zoom settles. | Screenshot comparison at 50% and 400% |
| M1-06 | The brush draws ink that follows the pointer, size and smoothing from the left sidebar, color from the tool capsule. Pressure varies width when reported. | Stroke replay (`replayStroke`) plus screenshot |
| M1-07 | A stroke belongs to the sheet it started on and is stored in that sheet's coordinates (PDF points). Ink outside any sheet is discarded. | Core unit test + E2E reading `strokes()` points |
| M1-08 | The eraser removes whole strokes it touches. | E2E replay of an erase path |
| M1-09 | Undo and redo cover strokes and erasures, from the top bar and Ctrl-Z / Ctrl-Shift-Z. | E2E |
| M1-10 | Work autosaves to the sidecar file and is restored when the same PDF is reopened. | E2E reload test (browser platform: IndexedDB keyed by name+size) |
| M1-11 | Left sidebar shows the active tool's options. Sections collapse. Mode, Snapping, Commit present but disabled ("coming later"). | Screenshot test |
| M1-12 | Strokes can be recorded to fixture files from a dev-only toggle. | E2E writes and re-reads a recording (`StrokeRecording` JSON) |

**Budgets that start gating in M1** (write to `reports/perf.json` with `recordPerf` from `tests/e2e/helpers.ts`):

| Key | Budget |
|---|---|
| `inkLatencyP95Ms` | <= 16 ms, pointer event to painted stroke, p95, measured with `performance.now()` in-app |
| `panZoomFps` | >= 60 fps with 6 sheets and 500 strokes |
| `firstSheetVisibleMs` | <= 2000 ms after opening the 6-sheet fixture (already measured by the M0 smoke test) |

**Test API to implement:** `replayStroke` (real pointer events at recorded timestamps), `strokes`, `camera`, `undo`, `redo`, `setTool`, `setSetting`, `metrics().inkLatencyMs/fps` (all marked `TODO(M1)` in `src/app/testApi.ts`).

**Starting points from M0:** `src/app/pdf/pdfjs.ts` (load + render), `src/app/platform/` (open, sidecar, drop), `src/app/store.ts`, `/?smoke=tldraw` (tldraw 5.6.0 mounts with `hideUi`). Replace the M0 DOM sheet list in `App.tsx` with the tldraw board.

**Deliberately absent:** Reading panel, ghost geometry, snap markers, confidence chips, any model call.
