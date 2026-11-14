# 0009 Photo import runs in the browser on OpenCV.js

Date: 2026-11-14

## Context

Task P1 brings hand markup from a photo of a printed sheet into the editor as brush strokes. The method exists and is
tested: the trace-markup project (a Node command-line tool) registers the photo to a render of the sheet, separates
the ink from the drawing and the paper, and traces it into centreline strokes. It uses four libraries: OpenCV.js for
feature matching, homographies, template matching and morphology; sharp (libvips) to decode, resize and blur; mupdf
to render the PDF page; heic-decode for iPhone photos.

The editor is a web app (decision 0007). sharp and mupdf's Node build do not run in a browser.

## Decision

1. **Port the pipeline to TypeScript in `src/app/photo/pipeline`**, working on plain typed-array rasters. It is kept
   close to the original, function for function, so fixes can travel both ways.
2. **New dependency: `@techstark/opencv-js` 4.11.0-release.1** (Apache-2.0), the same build the original uses. It is
   OpenCV compiled to WebAssembly with the WASM embedded: one 11 MB CommonJS file. It is imported only by
   `pipeline/cv-browser.ts`, which only the photo worker imports, so it is fetched the first time a photo is
   imported and never on start-up. The pipeline receives it through `provideCv()`; Node tests hand it in with
   `require`.
3. **sharp is replaced in code**, not by another dependency: a Lanczos-3 reduction and a Gaussian blur with libvips's
   kernel (`pipeline/raster.ts`). The kernels are matched on purpose: the ink thresholds were tuned against them, and
   OpenCV's wider default blur made thin printed lines come back as ink.
4. **mupdf is replaced by the document's own `PageRenderer`** (pdf.js for PDFs, the vector renderer for `.drawing`),
   run on the main thread; the pixels are transferred to the worker. A `.drawing` therefore works the same as a PDF.
5. **The photo is decoded by the browser** (`createImageBitmap` in the worker, EXIF orientation applied). No HEIC
   decoder is bundled.
6. **`StrokeHistory.addMany`**: an import is one undo step. `core/types` is unchanged; an imported stroke is an
   ordinary `Stroke`.

## Alternatives considered

- **A server function that runs the original tool.** No port, and HEIC would work. But photos of project drawings
  would leave the machine, Vercel Functions cap the request body below a phone photo's size, a run takes tens of
  seconds, and it needs the PDF uploaded too (or cannot handle `.drawing` at all).
- **Writing the image processing without OpenCV.** AKAZE, RANSAC homographies and template matching are the bulk
  of the registration; re-implementing them is weeks of work and a new source of error.
- **OpenCV's own `opencv.js` from a CDN.** Not pinned by the lockfile, needs network at import time, and the stock
  build does not include AKAZE.

## Consequences

- The lazy worker chunk is about 11 MB (about 3 MB compressed). It is loaded on the first import only.
- Peak memory during an import is a few hundred MB for a large sheet. The working raster is capped at 4800 px on
  the long side and the photo at 6000 px; the worker is terminated after each import, which frees the WASM heap.
- The port was checked against the original on its own synthetic test photo with ground truth: at 150 dpi the
  original finds 98.0% of the true ink and the port 98.5%. Both occasionally read a printed line near the sheet edge
  as a black stroke, at different working resolutions (see the task file's known limits).
