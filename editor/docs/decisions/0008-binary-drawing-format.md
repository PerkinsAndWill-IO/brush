# 0008 Read the binary `.drawing` format from `schema/`

Date: 2026-11-14

## Context

The repo now holds the real `.drawing` format next to the Editor: `schema/schema/drawing-format.md` (container) and
`schema/schema/drawing.schema.json` (header). It is a gzip stream of `DRAWING\0`, a version, a JSON header and a buffer of
`f32` coordinate blobs and PNGs. Pages are sheets and views, drawn as `path`, `segs`, `fill`, `text` and `image` items in
paper feet, y up; every item names the host element it belongs to, and `elements` carries each element's class, category,
family, type, level and parameters. There is no PDF in it.

The Editor's `.drawing` until now was its own placeholder (decisions 0002 and 0005): a JSON manifest of element
footprints plus an embedded PDF for display. Nothing outside the Editor writes it.

## Decision

The Editor reads the binary format as its `.drawing`. The manifest packages of 0002/0005 stay readable (the M5 fixtures
and eval use them), but they are legacy; `openSource` tells the two apart by content (gzip or `DRAWING\0` versus JSON or
ZIP).

1. **Reader, `src/core/drawing`** (pure). A port of `schema/src/drawing-file.ts` with the same reading rules and error
   messages (page, item, field). It converts to sheet coordinates once while reading: `x_pt = (x - min.x) * 864`,
   `y_pt = (max.y - y) * 864`. Widths, dashes, text size and `maxWidth` scale by 864, the text direction flips its y,
   and images become a top-left rectangle. Pages are sorted sheets first, then views, as in the viewer. Gzip is the
   app's job (`src/app/source/drawing-file.ts`, platform `DecompressionStream`).
   Copied, not imported from `schema/`: the folders are separate apps with their own builds and Vercel projects, and
   the Editor needs sheet coordinates rather than the viewer's scene model.
2. **Rendering, `src/app/drawing/render.ts`.** A canvas renderer (strokes batched into a `Path2D` per style run, lines
   never thinner than one device pixel, Arial text, PNG images). `LoadedSource.pages` is a `PageRenderer`. For PDFs it
   wraps `renderPageAt`, for `.drawing` it is this renderer, and the board no longer sees a pdf.js document.
3. **Sheets and context, `src/core/context/drawing.ts`.** One `Sheet` per page. The id is the host page id, plus number
   and name. `scale` is the page's scale text when it has one (views). For sheets it is estimated from walls whose
   model length is known (`CURVE_ELEM_LENGTH`, mm) against their drawn length, snapped to a standard scale. The context
   has `origin: 'package'`, confidence 1 and `hostRef` = element id, built from the items of each element per view:

   | Category | Item |
   |---|---|
   | Walls | `wall`: centerline along the principal axis of the drawn outline, `props.thicknessPt` = drawn thickness |
   | Doors, Windows | `opening`: the opening segment on the host wall's centerline (`props.hostWall`, `widthPt`) |
   | Furniture, Casework, Plumbing Fixtures, Specialty Equipment | `fixture`: oriented box |
   | Grids | `grid`: the grid line, `text` = grid name |
   | Rooms | `unknown`, `role: 'room'`: the largest colour-fill ring, `label` = room name (what `roomAt` reads) |
   | text items | `label`, role from the element (room, grid, tag, dimension, titleblock, text) |
   | annotation (title blocks, views, viewports, tags, dimensions, levels...) | none |
   | anything else | `unknown`: oriented box, still targetable by id |

   Plan kinds are emitted only where `classifySheet` (the title words the PDF path reads) says plan or unknown. On other
   pages, elements become `unknown` items. A `sheet-info` item carries the sheet type for `sheetInfo()`.
4. **Palette.** `paletteFromDrawing` lists the model's wall types (median drawn thickness), door families (width from a
   "900 x 2100" type name, else measured) and furniture types (oriented box), measured on plan views of known scale.
   An empty list falls back to `DEFAULT_PALETTE`.
5. The source is `DrawingFileSource` with `kind: 'package'`, so command files and the host pill treat it as a host
   package. `hostWallRef` and `delete.targets` carry host element ids. `project` is the source file name without its
   extension.

No change to `core/types`. No new dependency.

## Consequences

- Any `.drawing` the schema viewer opens also opens in the Editor, e.g. `schema/public/examples/house.drawing`
  (unit test `tests/unit/context/drawing.test.ts`, e2e `tests/e2e/m5-drawing.spec.ts`; both skip when the file is absent).
- The format has one owner: changes to `schema/schema/drawing-format.md` need the same change in `src/core/drawing`.
- Footprints are derived from drawn geometry, so a curved wall becomes its chord and a wall drawn in several pieces one
  line. An exporter that wants exact footprints could add them to the format later. The Editor would then prefer them.
- Follow-up: move the M5 fixtures and eval (`scripts/fixtures/gen-package.mjs`) to the binary format and retire the
  manifest containers.
