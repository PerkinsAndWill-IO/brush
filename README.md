# brush

A browser viewer for Revit sheets. It draws a sheet 1:1 on a canvas (floor plans, elevations, axonometrics); hovering a
line, fill or text shows the metadata of the Revit element it belongs to. A separate tool writes one "scene" JSON per
sheet; this app only reads them.

## Run

```sh
source ~/.nvm/nvm.sh && nvm use 24     # WSL
npm install
npm run dev                            # http://localhost:5199/
npm test                               # vitest
npm run typecheck                      # tsc --noEmit
npm run build                          # typecheck + vite build into dist/
```

Open a scene by dragging a `.json` onto the page, with the **Open .json** button, with `?scene=<url>`, or by choosing one
from the switcher. The switcher lists `public/scenes/index.json` (`[{"file": "fixture.json", "title": "..."}]`; files are
served from `public/scenes/`).

Wheel zooms about the cursor, drag pans, **Fit** fits the page, **1:1** is true paper size (96 CSS px per inch). Hover
shows the element card; click pins it, Esc or a click on empty paper releases it. Items without an element (`el: null`)
show no card.

Real scenes: scenes come from an external extractor that writes the contract below ([`schema/scene.schema.json`](schema/scene.schema.json),
JSON Schema draft 2020-12; `npm test` validates the fixture against it). Put them in `public/scenes/real/` (git-ignored: large, and
derived from sample data under its own licence) and list them in `public/scenes/index.json`; a listed file that is missing shows an
error in the status bar. Example: `<extractor> sheets <model> --format json --out public/scenes/real`.

Test scenes: `npm run gen:fixture` rewrites `public/scenes/fixture.json`. `npm run gen:synthetic` writes a 300,000-segment
scene to `public/scenes/synthetic-300k.json` (git-ignored; `-- --segs N --out file` to change); open it with
`?scene=/scenes/synthetic-300k.json`. The status bar shows load time, and `window.__brush` holds draw and hover timings.

## Scene contract (format 1)

Machine-readable: [`schema/scene.schema.json`](schema/scene.schema.json).

Coordinates are paper feet, x right, y up. The page is the white rectangle `min`..`max`. Items are in draw order.

```json
{
  "format": 1,
  "sheet": {"id": 382617, "number": "A102", "name": "Plans"},
  "min": [0.0, 0.0], "max": [2.76, 1.95],
  "items": [
    {"t": "path", "pts": [[x, y]], "closed": false, "w": 0.0006, "c": [0, 0, 0], "dash": [], "el": 12345, "view": 678},
    {"t": "segs", "segs": [x0, y0, x1, y1], "w": 0.0006, "c": [0, 0, 0], "dash": [], "el": 12345, "view": 678},
    {"t": "fill", "rings": [[[x, y]]], "c": [200, 200, 200], "el": null, "view": 678},
    {"t": "text", "text": "Kitchen", "at": [x, y], "size": 0.008, "anchor": "cm", "dir": [1, 0], "maxWidth": null, "c": [0, 0, 0], "bold": false, "el": 999, "view": 678},
    {"t": "image", "min": [x, y], "max": [x, y], "png": "<base64>", "el": null, "view": null}
  ],
  "elements": {
    "12345": {"class": "...", "category": "Walls", "name": "...", "family": "...", "type": "...", "level": "...", "params": [{"name": "Area", "value": "12.5 m²"}]}
  }
}
```

- `w` is the stroke width in paper feet; the viewer never draws thinner than one device pixel. `dash` is on/off lengths in
  paper feet, empty is solid.
- `segs` is a flat array of independent segments. `fill` is even-odd over all rings.
- `text.at` is the point of the text box named by `anchor` (horizontal `l|c|r`, then vertical `t|m|b`). `size` is the
  capital height, `dir` the unit baseline direction, `maxWidth` wraps at word breaks, `\n` breaks lines. Arial or sans-serif.
- An element may carry `tagged: <id>`, a reference to another element (a label or tag). Hovering it shows the referenced element's
  card, titled `<class> → <name>`, and highlights the items of both. `category` may be null: the card shows `class`.
- `sheet` may be `null` for a single view, with an optional `viewInfo: {id, name, scale}`. `el` and `view` may be null.
- Unknown item types are skipped. A scene that breaks the contract (wrong `format`, odd-length `segs`, non-numbers) is
  rejected with a message naming the item.

## Layout

`src/scene.ts` parsing and validation, `src/geom.ts` view transform and geometry, `src/text.ts` text layout and boxes,
`src/grid.ts` uniform grid index, `src/hit.ts` hit-testing: all DOM-free and covered by vitest. `src/render.ts` draws on
canvas (strokes batched into `Path2D` once per scene) and `src/main.ts` wires the page.
