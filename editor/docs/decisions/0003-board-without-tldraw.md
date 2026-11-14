# 0003 Board and brush without tldraw (M1 fallback)

Date: 2026-11-14 · Lane: Canvas · Requirement IDs: M1-03 … M1-09

## Decision

The M1 board is a hand-written camera over plain DOM: one transformed "world" element holds one element per
sheet (a pdf.js `<canvas>` for the page, an `<svg>` ink layer and an `<svg>` overlay layer, both with
`viewBox` = the sheet in PDF points). Pointer, wheel and keyboard input are handled by the app itself
(`src/app/board/Board.tsx`). The pure parts (layout, board ↔ sheet ↔ screen transforms, hit-testing,
ink outline, undo history) live in `src/app/board/*.ts` with no DOM and are unit tested.

tldraw 5.6.0 stays installed only for the `/?smoke=tldraw` library smoke page. It is not used by the editor.

This is the fallback the spec allows ("fall back to a plain `<canvas>` with a hand-written camera only if the
custom brush tool fights the SDK").

## Why (read in `node_modules`, tldraw 5.6.0)

1. **Ink latency budget (p95 ≤ 16 ms, pointer event to painted stroke).** `Editor.dispatch` queues every
   `pointer_move` into `_pendingEventsForNextTick` and only processes it on the next `tick`
   (`@tldraw/editor/dist-esm/lib/editor/Editor.mjs`, `dispatch` / `_flushEventsForTick`). The resulting store
   change then re-renders the shape through React. A custom tool runs inside that pipeline, so a pen sample
   is processed one frame late before React even renders it: about one extra frame on every sample, which
   uses up the whole 16 ms budget. Our own handler updates a single SVG path imperatively in the next
   animation frame.
2. **Sheet coordinates (M1-07).** Strokes must be stored in sheet points, belong to the sheet they started
   on and never move with layout. tldraw shapes live in page space (the draw shape stores
   base64-encoded page-relative segments, `DrawShapeUtil.mjs` / `b64Vecs`). A custom brush would keep a
   second copy of every stroke in sheet space and sync the two on every edit, undo and reload.
3. **What we would actually use.** The default UI is hidden, the draw tool and shapes are replaced, the
   undo history would need custom marks to group live erasures, and persistence is our own sidecar. That
   leaves the camera, which is about 60 lines here (`layout.ts` `zoomAt`, `fitCamera`).
4. **Production license.** tldraw needs a license key in a packaged build or it runs watermarked or in dev
   mode only (DOCS.md "License key"). Without tldraw the editor no longer needs the key. The smoke page still
   needs one only if it ships, and it doesn't.

## Alternative considered

tldraw with a custom `sheet` shape and a custom `brush` `StateNode`, with a wet-ink canvas layered on top of
it outside the store to get around the tick batching. We rejected it because it means two rendering paths
for the same stroke, and two sources of truth for the camera (tldraw's, plus the sheet-space transform the
replay API needs).

## Consequences

- We own pan, zoom, pinch and the hit-testing for the eraser. All of it is covered by `tests/e2e/m1-*.spec.ts`
  and `tests/unit/app-*.test.ts`.
- Zoom changes `transform: translate() scale()` on one element. While the camera moves the world element is
  `will-change: transform` (composited, raster kept), and on settle pages re-render at the new resolution
  (M1-05).
- If M3 needs tldraw features (e.g. selection, transforms of committed elements), revisit. The per-sheet
  overlay `<svg>` and the `BrushEngine` hooks (`src/app/engine.ts`) are where M2 and M3 plug in.
- No dependency was added or removed.
