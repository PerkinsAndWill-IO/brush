# 0006 Raster-heavy sheets: image-less context and preview, sheet type and title block

Date: 2026-11-14

## Context

The first real project bundle (`fixtures/pdfs/kro-project-3-sheets.pdf`, 3 A0 sheets from Revit via Autodesk Docs)
missed every budget: `loadPdf` ~46 s in headless Chromium, context 8-42 s per sheet. Profiling (pdf.js 6.5.438,
Node legacy build): each page carries ~590 (axo: ~160) JPEG image tiles with soft masks, ~450 Mpx in all. pdf.js
decodes every tile inside `getOperatorList` (16 s / 18 s / 6 s per page). Text content took 0.05-0.2 s; our
operator walk ~50 ms; vector content is small (3.4k / 1.8k / 0.1k paths). The 9 s inference on the elevation was
room flood-fill stamping walls "metres thick": the company name "1:1 landskab ApS" in the title block parsed as
scale 1:1, which made the wall-thickness window 1500 pt wide. The plan's linework is mostly inside the raster
tiles, so vector wall detection cannot see it; vector exports of the same drawings will follow, so wall
detection was not tuned for these files.

## Decisions

1. **Context ignores images.** The context worker and `scripts/build-contexts.ts` open documents with
   `CONTEXT_DOC_PARAMS = { maxImageSize: 0 }` (pdf.js drops larger images at parse time). Raster-only is then
   "no vectors and no text" (`extractPage(..., { imagesSkipped: true })`). Extraction: 19/33/8.5 s -> 0.56/0.23/0.06 s.
2. **Caps degrade, never block.** `extractPage` stops the operator walk after 600 ms or 400k vertices;
   `inferContext({ budgetMs: 800 })` skips rooms and fixtures once over budget. Either sets `partial` on the
   sheet-info item. Room stamping clamps wall thickness to 40 pt, and wall thresholds use the scale only when it
   is 1:20-1:2000 (else 1:100).
3. **Preview first for slow pages** (`src/app/pdf/pdfjs.ts`, no call-site change). `loadPdf` also opens an
   image-less preview document (own pdf.js worker). `renderPageAt` starts the full render offscreen; if it is not
   done in 350 ms it paints the preview into the caller's canvas (`data-preview="1"`) and resolves, then copies the
   full render over it when ready. After a page's first full render, renders are plain (zoom keeps the old
   raster on screen until the sharper one is ready, M1-05). Alternative considered: tiling / OffscreenCanvas in a
   worker; rejected for now (more code, the cost is image decoding, not rasterisation).
4. **Sheet info without a type change.** `SheetContext` (frozen) has no sheet-type field, so inferred contexts
   carry one `unknown` item, `id: 'sheet-info'`, `props: { role: 'sheet-info', sheetType, sheetTypeBy, number?,
   title?, partial? }`, geometry a 1-pt box in the sheet's bottom-right corner (never near drawn content). Read it
   with `sheetInfo(ctx)`. `classifySheet(titleBlockInfo)` uses the drawing code's type field first
   (PLN/PLA, ELE/ELV/FAC, SEC/COU, SYN/AXO/ISO/PER/3D, DET, SCH), then title words (EN/FR/DA/DE/NL/ES/IT).
   Sheets typed elevation / section / axonometric / detail / other get **no walls, openings, fixtures or rooms**
   (spec risk table: prefer no context to wrong context); labels and grids stay. `unknown` keeps today's behaviour.
5. **Title block.** Structured drawing codes ("KRO-APD-ARC-PLN-A1A-N01-0001 - 007", 4+ dash-separated fields)
   become `Sheet.number` (normalised, no spaces); the name is the largest-font lines near the code, joined with
   " · ". `loadPdf` reads title blocks from text only on the preview document, capped at 700 ms.
   Scale: a ratio followed by a word is not a scale (paper-size suffixes excepted), "1:1" needs a scale word in the
   same text, and a ratio next to a scale label ("Échelle :", "SCALE", "Målestok", "Maßstab") ranks like one in it.

6. **Vector plan walls** (replacement KRO file, page 0: 206k operators, 189k stroked paths, 2.3k filled outlines).
   Cut walls are filled poché outlines with jogs, not rectangles: `pocheFromPolygon` turns each thin filled
   polygon (2·area/perimeter within the wall-thickness window) into runs between opposite parallel edges.
   `dropStripeArrays` removes runs with 3+ similar parallel neighbours within 2 m across (decking, parking bays,
   zebra hatches). Plan walls 26 -> ~570. Known false positives: long parallel site/curb lines outside the building.
   `findHatch` uses a flat orientation x cell grid (counting sort) instead of the Map box hash.
7. **Raw cache size.** `build-contexts.ts` writes `<pdf>.<page>.raw.json` only under 2 MB (the KRO plan's is 35 MB);
   the inferred context is always written.

Open: the KRO vector plan misses the 1 s context budget in Node (pdf.js `getOperatorList` ~1.6-2 s cold, of which
~1.1 s is structured-cloning 188k per-path Float32Arrays across the fake worker; text 0.3 s; walk 0.1 s; infer
~1.3 s). Caps do not help here: the parse cost is paid before any cap can act. Options for a human: a budget
for large real sheets, a progressive (text-first, vectors-later) context, or a content-stream parser of our own.

No new dependency.
