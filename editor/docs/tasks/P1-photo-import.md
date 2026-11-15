# P1 — Import markup from a photo

**Goal:** bring paper back into the editor. An architect marks up a printed sheet (or a sheet of trace over it) with
pen and marker, photographs it, and the markup lands on the same sheet in the editor as brush strokes.
**Exit:** all requirements below pass in `tests/unit/photo/pipeline.test.ts`, `tests/unit/app-photo-import.test.ts` and
`tests/e2e/p1-photo-import.spec.ts`.
**Lane:** Canvas (app), plus Harness for the new dependency (decision 0009). No change to `core/types`.

| ID | Requirement | Acceptance test |
|---|---|---|
| P1-01 | With a drawing open, the **Import photo** button in the tool capsule (bottom) opens a dialog: choose a photo, the sheet it shows (default: find it), and which pens to pick up (all, coloured only, black only). An image file dropped on an open drawing opens the same dialog with that photo instead of being opened as a drawing. A sheet chosen for one document is not carried over to the next. Escape or Cancel closes it and stops a running import. | E2E: capsule button, file input, dropped image, Escape, sheet choice not carried to another document. Unit: `knownSheetId` |
| P1-02 | The photo is matched to the sheet it shows. With no sheet chosen, up to 16 sheets are tried (the active sheet first) with a quick feature match against a 50 dpi render. Every candidate alignment is checked tile by tile (do the sheet's lines land on the photo's?), so a few right feature matches are enough and a large wrong consensus is turned down; this lets a print drawn in another style than the app draws the sheet (another export: line weights, fills, colours, text) still match. The sheet whose drawing locks onto the photo in the most tiles wins; all of them are compared, because sheets of one project look alike. The photo is then registered to that sheet rendered at about twice the resolution the photo has on it (36 to 150 dpi, long side at most 4800 px): features, then tile matching, then a smooth correction for paper that does not lie flat. | Unit: `probe` and registration residual under 1 px on a synthetic photo; `candidateSheets`, `pickSheet`, `workingDpi`. E2E: the right floor is found among six look-alike plans |
| P1-03 | Whatever the drawing does not explain is ink. It is split by pen colour, and each pen's ink is traced into centreline strokes with a pen width, in sheet points. The drawing's own linework, the paper tint, uneven light and objects lying on the sheet are not ink. A marker fill too thick to be a stroke comes back as its outline. | Unit: red and blue pens come back as two layers in their ink colours, on the drawn lines, with the drawn width, and nothing else is traced |
| P1-04 | Each traced stroke becomes one brush stroke on that sheet: resampled to pen-like samples (at most 2 pt apart, every vertex kept), `size` = pen width in points, `color` = the ink colour, timestamps from the length at a steady speed. They are plain ink: no prediction runs on them and no command is logged. They render, erase, autosave and reload like drawn strokes. | Unit: `markupToStrokes`, `resampleCentreline`, render through `inkRender`. E2E: strokes on the sheet in the right place and colour |
| P1-05 | One import is one undo step: Undo removes every imported stroke, Redo brings them back. | Unit: `StrokeHistory.addMany`. E2E: one `undo()` empties the session |
| P1-06 | A photo that matches no sheet (or not the chosen one) adds nothing and says so in the dialog, which stays open for another try. So does an image the browser cannot decode. If another file is opened while an import runs, nothing is imported. | Unit: `probe` returns null and `photoToMarkup` rejects on the wrong sheet. E2E: the message, and no strokes |
| P1-07 | The strokes of one import are a group: one row under This session (sheet, stroke count, elements made), not one row per stroke. **Remove** on that row deletes every stroke of the import, and any element made from them, as one undo step. The group is the id prefix of its strokes (`p<time><seq>-<n>`), so it survives the sidecar and a reload with no new data. | Unit: `photoGroupOf`, `photoGroups`, erase/undo of a group. E2E: one row, Remove, undo |
| P1-08 | **Make elements** (on the group row, and in the dialog after an import) reads the import's strokes with the brush's first pass and current settings, as if each had just been drawn: a reading the brush would auto-commit becomes an element and its command; one it would offer two chips for, or markup, stays ink. All of it is one undo step. Each traced stroke is read on its own (an import has no pen timing to group gestures by), and the second pass is not asked. | Unit: `readStrokes` (wall and door strokes from an import become a wall and a door), `StrokeHistory.commitMany`. E2E: elements only from the import, one undo step |
| P1-09 | When the photo matches none of the open sheets, the dialog says so and offers **Choose the printed PDF…**: the paper may have been printed from another file than the open one (the PDF of a sheet whose `.drawing` is open), drawn so differently that it hardly matches. Choosing it runs the import again, matched to that file's pages (up to 16; with the open sheet chosen, the pages titled like it first, wherever they are in the file); the strokes go on the open sheet that page is (the sheet chosen in the dialog, else the one whose number and name are in the page title, short numbers like A01 included, else the one at the same position when both files have as many pages, else the only one), scaled from page to sheet. Pages of other proportions (over 2 %) are refused. The choice is kept for the next photo of the same drawing, shown as Printed from, and can be cleared. | Unit: `matchPrintedSheet`, `printedScale`. E2E: refused first, asked, matched to page 3 of the printed PDF, strokes scaled onto the chosen sheet; kept and cleared |
| P1-10 | HEIC photos (the iPhone format) are read in every browser, not only Safari: when the browser cannot decode a photo and it is HEIF, libheif (WebAssembly, decision 0010) decodes it, upright. The dialog's file picker offers .heic and .heif files. | Unit: `isHeif`, `decodeHeif` on a HEIC test card (`fixtures/photos/test-card.heic`). E2E: the card is read in the browser (the import then refuses it only because it shows no sheet) |
| P1-11 | **From phone** in the dialog shows a QR code. Scanned with a phone it opens a page (`/?phone=<slot>`) with one button, take or choose a photo; the photo is sent to the dialog, which puts it under Photo by itself. Through `api/photo-relay`, a private Vercel Blob store (decision 0011): the photo is deleted when it is handed over; a code works once, for 15 minutes. Without a Blob store, or on localhost, the dialog says why there is no code. | Unit: the relay (hand-over once, refusals, not set up) with Blob replaced, slot ids, waiting and expiry. E2E: the phone page posts the photo to its slot; the dialog explains localhost |
| P1-12 | When an import adds strokes, a roll of trace paper unrolls over that sheet (the roll glides left to right, the paper and the imported ink are laid behind it) and the strokes sit on it. A control at the top of the board sets the trace's opacity (0 to 100 %, remembered in the browser) and rolls it up or lays it again; rolling it up leaves the strokes. When the sheet's photo strokes are all gone (undo, Remove, erased) the trace rolls up by itself. Not saved with the drawing. Reduced motion: no animation. | Unit: `tracePaper` unroll, settle, roll up, re-unroll, opacity clamp |
| P1-13 | While the photo is read the dialog shows it on a light table, acted out per stage (develop, find the sheet, pin it down, trace), four steps, a bar that never stalls or ends early, a rotating line of patter and the elapsed time; the raw progress lines are under Details. Opt-in (remembered): a small preview of the photo goes to the hosted model through the AI Gateway proxy for one line, "First glance", about what the markup shows; failure shows nothing and never affects the import. After an import that added strokes, the dialog steps aside to a card so the trace is seen unrolling. | Unit: `stageOfLine`, `advanceStage`, `sheetOfLine`, `progressFraction` |

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
- The sheets are rendered on the main thread; if the tab is in the background the browser pauses that and the
  import waits.
- When the app draws the sheet differently from the print in the photo (another export of the same sheet), the photo
  may not match it at all, or match it and take whatever the print shows and the app does not (hatching, symbols,
  other text, coloured lines) for markup. P1-09 is the way out: match the printed PDF. Measured on a phone photo of
  trace paper over an A3 print of the KRO plan: no match against the web viewer's .drawing; against the PDF, 130
  strokes in about 80 s.
- With one sheet to compare, a photo of a look-alike sheet (another floor of the same building) can be accepted as
  that sheet: the tile check sees the shared grid, walls and title block. Seen with the office fixtures (a photo of
  level 3 taken for the open level 2). Choose the right file and sheet.

**Budgets:** none new. An import runs off the main thread and is not on the pen path. Measured on the original
project's test photo (12 MP photo, 36 x 24 in sheet at 150 dpi): about 20 s in Node.
