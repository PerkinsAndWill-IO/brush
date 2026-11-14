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

## strokes/
Synthetic stroke corpus; see `strokes/README.md`.
