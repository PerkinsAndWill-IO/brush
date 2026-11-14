# 0009 Read `.drawing` version 2, with `fzstd`

Date: 2026-11-14

## Context

Version 2 of the format (`schema/schema/drawing-format-v2.md`) drops the gzip around the file. Each page and the
elements table are separate zstd frames, coordinates are `i32` in 0.01 mm units delta-coded per blob, and each page
carries per-element boxes. A real export is about a third of its version 1 size (`kro-test.drawing`: 29.8 MB to 8.6 MB,
`kro-test-lean.drawing`: 12.1 MB to 3.3 MB). Chrome has no zstd `DecompressionStream`, so the reader needs a zstd decoder.

## Decision

1. **Dependency `fzstd` 0.1.1**, a pure JavaScript zstd decompressor (about 8 kB minified, no dependencies, works in
   the browser and in Node). Alternatives considered: a WASM zstd (`@bokuweb/zstd-wasm`, `zstddec`): faster on very
   large frames, but it adds a `.wasm` asset and an async init to the Vite build and the Vercel deploy, and our frames
   decode in about half a second in Node; the browser's `DecompressionStream`: no zstd in Chrome. Writing the converter and the
   tests needs no new dependency: Node 22.15+ has zstd in `node:zlib`.
2. **Reader, `src/core/drawing/format-v2.ts`** (pure). `parseDrawingPayloadV2` returns the same `DrawingDocument` as
   version 1, in sheet points. One loop per blob undoes the delta, dequantises and converts to sheet points
   (`x_pt = X * 864 / 30480`, `y_pt = height_pt - Y * 864 / 30480`) straight into a `Float32Array`. It shares the item
   and page parsing, and the blob reference rules, with the version 1 reader (`parsePage`, `blobRef`, `BlobSource` in
   `format.ts`); version 1 reading is unchanged.
3. **Dispatch** in `src/app/source/drawing-file.ts`: a gzip stream is version 1, a raw `DRAWING\0` payload is read by
   its version number (2 here, anything else by the version 1 reader).
4. **Boxes** are kept on `DrawingPage.boxes` (optional, version 2 only), converted to sheet points as
   `[minX, minY, maxX, maxY]`. Nothing reads them yet.
5. **Pages decode in file order, sheets first, the first sheet first; the elements table last.** The source interface
   takes a whole `DrawingDocument` (the palette and the context need every page), so nothing paints until the reader
   returns; a lazy per-page load would change `DrawingFileSource`. The order is in place for when that changes.
6. **Missing `elements`** in a version 2 header reads as no elements (as in version 1); a missing `unitsPerFoot` is
   rejected like any value other than 30480.
7. **Converter** `scripts/drawing-v1-to-v2.mjs in.drawing [out.drawing] [--level 19]`.

## Consequences

- The format has one owner still: changes to `drawing-format-v2.md` need the same change in `format-v2.ts` and the
  converter. Tests: `tests/unit/drawing/format-v2.test.ts` (hand-built bytes with literal expected values, version 1
  versus version 2 within 0.005 mm, every reading rule).
- Decoded coordinates differ from version 1's by at most half a unit (0.005 mm of paper) plus `f32` rounding.
