# P1 — Import markup from a photo

**Goal:** bring paper back into the editor. An architect marks up a printed sheet (or a sheet of trace over it) with
pen and marker, photographs it, and the markup lands on the same sheet in the editor as brush strokes.
**Exit:** all requirements below pass in `tests/unit/photo/pipeline.test.ts`, `tests/unit/app-photo-import.test.ts` and
`tests/e2e/p1-photo-import.spec.ts`.
**Lane:** Canvas (app), plus Harness for the new dependency (decision 0009). No change to `core/types`.

| ID | Requirement | Acceptance test |
|---|---|---|
| P1-01 | With a drawing open, **Import photo…** in the app menu (top right) opens a dialog: choose a photo, the sheet it shows (default: find it), and which pens to pick up (all, coloured only, black only). An image file dropped on an open drawing opens the same dialog with that photo instead of being opened as a drawing. A sheet chosen for one document is not carried over to the next. Escape or Cancel closes it and stops a running import. | E2E: menu item, file input, dropped image, Escape, sheet choice not carried to another document. Unit: `knownSheetId` |
| P1-02 | The photo is matched to the sheet it shows. With no sheet chosen, up to 16 sheets are tried (the active sheet first) with a quick feature match against a 50 dpi render, and the one with the most consistent matches wins; all of them are compared, because sheets of one project look alike. The photo is then registered to that sheet rendered at about twice the resolution the photo has on it (36 to 150 dpi, long side at most 4800 px): features, then tile matching, then a smooth correction for paper that does not lie flat. | Unit: `probe` and registration residual under 1 px on a synthetic photo; `candidateSheets`, `pickSheet`, `workingDpi`. E2E: the right floor is found among six look-alike plans |
| P1-03 | Whatever the drawing does not explain is ink. It is split by pen colour, and each pen's ink is traced into centreline strokes with a pen width, in sheet points. The drawing's own linework, the paper tint, uneven light and objects lying on the sheet are not ink. A marker fill too thick to be a stroke comes back as its outline. | Unit: red and blue pens come back as two layers in their ink colours, on the drawn lines, with the drawn width, and nothing else is traced |
| P1-04 | Each traced stroke becomes one brush stroke on that sheet: resampled to pen-like samples (at most 2 pt apart, every vertex kept), `size` = pen width in points, `color` = the ink colour, timestamps from the length at a steady speed. They are plain ink: no prediction runs on them and no command is logged. They render, erase, autosave and reload like drawn strokes. | Unit: `markupToStrokes`, `resampleCentreline`, render through `inkRender`. E2E: strokes on the sheet in the right place and colour |
| P1-05 | One import is one undo step: Undo removes every imported stroke, Redo brings them back. | Unit: `StrokeHistory.addMany`. E2E: one `undo()` empties the session |
| P1-06 | A photo that matches no sheet (or not the chosen one) adds nothing and says so in the dialog, which stays open for another try. So does an image the browser cannot decode. If another file is opened while an import runs, nothing is imported. | Unit: `probe` returns null and `photoToMarkup` rejects on the wrong sheet. E2E: the message, and no strokes |

**Where the work happens.** `src/app/photo/`: `pipeline/` is the image processing (a TypeScript port of the
trace-markup project: `register.ts`, `isolate.ts`, `strokes.ts`, `outline.ts`), which takes plain rasters and so
runs in a Web Worker (`worker.ts`) and in Node tests. `import.ts` renders the sheets on the main thread with the
document's own `PageRenderer` (so PDFs and `.drawing` files both work), drives the worker and adds the strokes.
`toStrokes.ts` and `plan.ts` are pure. `PhotoImport.tsx` is the dialog. OpenCV is loaded only inside the worker.

**Dev API:** `window.__brushDev.importPhoto(urlOrBlob, { sheetId?, ink?, keepCamera? })` runs an import and resolves
with its summary; `renderSheet(pageIndex, pxPerPt)` returns a sheet as the document renders it.

**Known limits.**

- Ink on top of a printed line cannot be told from the print: a pen crossing a wall leaves a short gap, and a pen
  running along a line is not picked up.
- Near the edge of a sheet, where the registration is extrapolated, a printed line can come back as a black
  stroke. The original pipeline does the same; "Coloured only" avoids it when the markup is in colour.
- A `.drawing` is rendered with the current display filters. Hidden categories are missing from the render and
  can turn into ink: use Show all before importing.
- HEIC photos open only where the browser decodes them (Safari). Elsewhere the dialog asks for a JPEG or PNG.
- The sheets are rendered on the main thread; if the tab is in the background the browser pauses that and the
  import waits.
- Imported strokes are ink only. Reading them as walls, doors or furniture is a possible follow-up.

**Budgets:** none new. An import runs off the main thread and is not on the pen path. Measured on the original
project's test photo (12 MP photo, 36 x 24 in sheet at 150 dpi): about 20 s in Node.
