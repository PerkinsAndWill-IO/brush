# 0009 Read the zstd `.drawing` format (version 1), with `fzstd`

Date: 2026-11-14

## Context

The `.drawing` format, version 1 (`schema/schema/drawing-format.md`), drops the gzip around the file. It was first
written as "version 2" and renamed before release: the gzip format of decision 0008 is now "legacy"
(`schema/schema/drawing-format-legacy.md`). Each page and the
elements table are separate zstd frames, coordinates are `i32` in 0.01 mm units delta-coded per blob, and each page
carries per-element boxes. A real export is about a third of its legacy size (`kro-test.drawing`: 29.8 MB to 8.6 MB,
`kro-test-lean.drawing`: 12.1 MB to 3.3 MB). Chrome has no zstd `DecompressionStream`, so the reader needs a zstd decoder.

## Decision

1. **Dependency `fzstd` 0.1.1**, a pure JavaScript zstd decompressor (about 8 kB minified, no dependencies, works in
   the browser and in Node). Alternatives considered: a WASM zstd (`@bokuweb/zstd-wasm`, `zstddec`): faster on very
   large frames, but it adds a `.wasm` asset and an async init to the Vite build and the Vercel deploy, and our frames
   decode in about half a second in Node; the browser's `DecompressionStream`: no zstd in Chrome. Writing the converter and the
   tests needs no new dependency: Node 22.15+ has zstd in `node:zlib`.
2. **Reader, `src/core/drawing/format.ts`** (pure). `parseDrawingPayload` returns the same `DrawingDocument` as
   the legacy reader, in sheet points. One loop per blob undoes the delta, dequantises and converts to sheet points
   (`x_pt = X * 864 / 30480`, `y_pt = height_pt - Y * 864 / 30480`) straight into a `Float32Array`. It shares the item
   and page parsing, and the blob reference rules, with the legacy reader (`parsePage`, `blobRef`, `BlobSource` in
   `format-legacy.ts`, whose entry point is `parseLegacyDrawingPayload`); legacy reading is unchanged.
3. **Dispatch** in `src/app/source/drawing-file.ts`: the first bytes decide, not the version number: a gzip stream (`1f 8b`) is legacy, a raw `DRAWING\0`
   file is this format. The reader accepts version 1, and also 2 for files written under the old name (a marked
   remove-later shim in `format.ts`).
4. **Boxes** are kept on `DrawingPage.boxes` (optional, absent for legacy files), converted to sheet points as
   `[minX, minY, maxX, maxY]`. Nothing reads them yet.
5. **Pages decode in file order, sheets first, the first sheet first; the elements table last.** The source interface
   takes a whole `DrawingDocument` (the palette and the context need every page), so nothing paints until the reader
   returns; a lazy per-page load would change `DrawingFileSource`. The order is in place for when that changes.
6. **Missing `elements`** in a header reads as no elements (as in the legacy format); a missing `unitsPerFoot` is
   rejected like any value other than 30480.
7. **Converter** `scripts/drawing-from-legacy.mjs in.drawing [out.drawing] [--level 19]`.

## Consequences

- The format has one owner still: changes to `drawing-format.md` need the same change in `format.ts` and the
  converter. Tests: `tests/unit/drawing/format.test.ts` (hand-built bytes with literal expected values, legacy
  versus zstd within 0.005 mm, every reading rule).
- Decoded coordinates differ from the legacy format's by at most half a unit (0.005 mm of paper) plus `f32` rounding.
