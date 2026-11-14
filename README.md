# brush

A browser viewer for 2D drawings: sheets and views with floor plans, elevations and axonometrics. It draws a page 1:1 on a
canvas; hovering a line, fill or text shows the metadata of the element it belongs to. A separate tool writes the drawings;
this app only reads them. The viewer owns the file format and contains no code for any authoring tool.

## Run

```sh
source ~/.nvm/nvm.sh && nvm use 24     # WSL
npm install
npm run dev                            # http://localhost:5199/
npm test                               # vitest
npm run typecheck                      # tsc --noEmit
npm run build                          # typecheck + vite build into dist/
```

## Opening files

- **`.drawing`**: the primary format, several pages in one binary file. See [`schema/drawing-format.md`](schema/drawing-format.md).
- **`.json`**: a scene, the simple single-page form (below).

Drag a file onto the page, use the **Open file** button, pass `?file=<url>` (`?scene=` still works), or choose one from the
switcher. The switcher lists `public/scenes/index.json` (`[{"file": "fixture.json", "title": "..."}]`; files are served from
`public/scenes/`), and its entries may be `.drawing` files. The content decides the format, not the file name: a gzip stream is
a `.drawing`, anything else must be scene JSON.

A `.drawing` with more than one page shows a page switcher (sheets first, then views: "A102 Plans", "{3D} (view)");
**PageUp** and **PageDown** move between pages. Elements are shared by all pages, so a card shows the same metadata wherever the
element appears.

Wheel zooms about the cursor, drag pans, **Fit** fits the page, **1:1** is true paper size (96 CSS px per inch). Hover
shows the element card; click pins it, Esc or a click on empty paper releases it. Items without an element (`el: null`)
show no card.

Real drawings: put them in `public/scenes/real/` (git-ignored: large, and derived from sample data under its own licence) and
list them in `public/scenes/index.json`; a listed file that is missing shows an error in the status bar.

Test scenes: `npm run gen:fixture` rewrites `public/scenes/fixture.json`. `npm run gen:synthetic` writes a 300,000-segment
scene to `public/scenes/synthetic-300k.json` (git-ignored; `-- --segs N --out file` to change); open it with
`?file=/scenes/synthetic-300k.json`. The status bar shows load time, and `window.__brush` holds draw and hover timings.

## Converting other files

A dropped file whose extension is not `.drawing` or `.json` is handed to a **converter**, which the viewer looks up at runtime. It
turns the file into `.drawing` bytes; the viewer shows "Converting model.ext ..." in the status bar, opens the result and offers
**Save .drawing**. With no converter configured the status bar says "No converter configured for .ext files". When a converter is
configured the file picker stops filtering by extension.

Configuration, read at start-up:

- `converter` in `config.json` next to `index.html` (`public/config.json`, edited on the server without a rebuild), or
- `VITE_CONVERTER_URL` at build time. `config.json` wins when both are set.

```json
{ "converter": "https://converter.example/convert" }
```

`converter` is the URL of an HTTP converter, or an object `{ "type": "http", "url": "..." }`; `type` selects the adapter.

**HTTP converter contract.** The viewer sends `POST <url>` with the file bytes as the body, `Content-Type:
application/octet-stream`, and `X-Filename: <file name>` (percent-encoded when it holds anything but printable ASCII, or a `%`).
A `200` answer carries the bytes of a `.drawing` file. Any other status is an error; the first 300 characters of its body are
shown in the status bar. A cross-origin converter must answer CORS preflight and allow the `X-Filename` and `Content-Type`
request headers.

**Adding an adapter** (for example a wasm module loaded from a configured URL exposing `convert(bytes) -> bytes`): implement
`ConverterAdapter` from [`src/converter.ts`](src/converter.ts) (`type` plus `create(settings, env) -> Converter | null`, where a
`Converter` has `convert(file) -> Promise<Uint8Array>`) and append it to `defaultAdapters`. Nothing else changes.

## Scene contract (format 1)

The single-page form. Machine-readable: [`schema/scene.schema.json`](schema/scene.schema.json) (JSON Schema draft 2020-12;
`npm test` validates the fixture against it). The header of a `.drawing` reuses these item and element definitions
([`schema/drawing.schema.json`](schema/drawing.schema.json)), with geometry stored as blobs instead of inline lists.

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

`src/scene.ts` the scene model and JSON parsing, `src/drawing-file.ts` the `.drawing` reader (pages become scenes with `Float32Array`
geometry), `src/open.ts` picks the reader from the bytes, `src/converter.ts` the converter hook, `src/geom.ts` view transform and
geometry, `src/text.ts` text layout and boxes, `src/grid.ts` uniform grid index, `src/hit.ts` hit-testing: all DOM-free and covered by
vitest. `src/render.ts` draws on canvas (strokes batched into `Path2D` once per page) and `src/main.ts` wires the page.
