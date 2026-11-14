# Fixtures

Generated, deterministic test data. Do not hand-edit; regenerate with:

    node scripts/fixtures/gen-pdfs.mjs      # fixtures/pdfs/*.pdf + *.truth.json
    node scripts/fixtures/gen-strokes.mjs   # fixtures/strokes/<kind>/*.json (needs the truth files)
    node scripts/fixtures/validate-pdfs.mjs # optional: opens PDFs with pdfjs-dist

Both generators have zero dependencies and resolve paths relative to their own location.

## pdfs/
- `office-6-sheets.pdf` 6 vector floor plans (A-101..A-601), 1191x842 pt, scale 1:100 (28.3465 pt/m), page labels set.
- `office-1-sheet.pdf` one vector floor plan (A-201).
- `scanned-1-sheet.pdf` one page with only a grayscale raster image (no vectors, no text).
- `corrupt.pdf` truncated PDF followed by garbage; `not-a-pdf.txt` plain text.
- `<name>.truth.json` ground truth in SHEET coordinates (top-left origin, y down, PDF points):
  `sheets[]: {pageIndex, number, name, sizePt, scale, ptPerMeter, walls[{id, centerline[p0,p1], thicknessPt, style}],
  openings[]/doors[{id, wallId, at, widthPt}], grids[{id, label, line}], labels[{text, at}], rooms[{label, polygon}],
  furniture[{id, kind, shape, bbox{x,y,w,h}}], distractors{dimensions, hatches, titleBlock}}`.
  Double walls: two parallel lines 7 pt apart (thicknessPt 7); thick walls: one stroke, line width 2.5.

## packages/
`node scripts/fixtures/gen-package.mjs` (after gen-pdfs). Binary `.drawing` files (`schema/schema/drawing-format.md`,
decision 0008) of the vector PDFs, drawn the way an exporter would, with host element ids on every item:
- `office-6-sheets.drawing`, `office-1-sheet.drawing`: sheet ids `900000 + pageIndex`, element ids
  `100000 + pageIndex * 10000 + offset + n` (walls 0, doors 1000, furniture 2000, rooms 3000, grids 4000,
  labels 5000, dimensions 6000, title block 9000). No sheet scale is stored; walls carry `CURVE_ELEM_LENGTH` (mm).
- `<name>.idmap.json` truth id (`<pageIndex>:<truthId>`) to host element id, used by `tests/eval/run-commands.ts`
  to derive the expected `hostWallRef` and delete targets.

## strokes/
Synthetic stroke corpus; see `strokes/README.md`.
