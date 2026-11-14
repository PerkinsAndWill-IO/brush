# M2 — Context

**Goal:** turn each PDF page's vector paths and text into a `SheetContext`; spatial index; snapping; a debug overlay.
**Exit:** on the fixture sheets, wall and grid candidates are found and a stroke end snaps to the expected point.
**Lanes:** Context (`src/core/context`), Stroke core (`src/core/geometry` spatial index and snapping), Canvas (pdf.js extraction to `RawPageContent`, worker, overlay).

| ID | Requirement | Acceptance test |
|---|---|---|
| M2-01 | App extracts `RawPageContent` (paths in sheet coords, line widths, dashes, text runs) from the pdf.js operator list and text content. | E2E: `contextFor(sheetId)` non-null on `office-1-sheet.pdf` |
| M2-02 | Wall candidates: pairs of parallel lines and thick strokes. | Unit test against `fixtures/pdfs/*.truth.json` walls |
| M2-03 | Grid lines: long dash-dot lines ending in a bubble with a letter or number. | Unit test against truth grids |
| M2-04 | Text labels become `label` items (e.g. "OFFICE 201"). | Unit test against truth labels |
| M2-05 | Sheet scale read from text like "1:100". | Unit test: scale = 100 on office fixtures |
| M2-06 | Scanned page gives an empty context with `shapeOnly: true`. | Unit + E2E on `scanned-1-sheet.pdf` |
| M2-07 | Every context item carries a confidence; prefer no context to wrong context. | Unit test: every item has confidence in [0,1] |
| M2-08 | Spatial index and snapping: a stroke end within `snapRadiusPt` snaps to the expected wall end or grid intersection. | Unit test + E2E replay asserting the snapped point |
| M2-09 | Context is built off the main thread (worker). | E2E perf mark |
| M2-10 | Debug overlay of detected items (dev toggle). | Screenshot test |
| M2-11 | Enclosing region: closed loop of wall candidates around a point, with its label. | Unit test on a fixture room |

**Budgets from M2:** `contextBuildMs` <= 1000 ms per sheet off the main thread; `snapDecisionMs` <= 2 ms per pointer move (both `reports/perf.json`).
