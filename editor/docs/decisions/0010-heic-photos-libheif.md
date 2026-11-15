# 0010 HEIC photos are decoded with libheif-js

Date: 2026-11-14

## Context

iPhones save photos as HEIC (HEIF with HEVC coding). Decision 0009 left decoding to the browser, and only Safari
decodes HEIC: in Chrome and Edge the photo import refused an iPhone photo and asked for a JPEG. Markup is
photographed on phones, so this is the common case, not an edge case. P1-10 asks for HEIC to be read everywhere.

The Windows HEIF codec cannot help: browsers do not use it, and the app runs in the browser (decision 0007).

## Decision

**New dependency: `libheif-js` 1.23.5** (pinned exactly), libheif 1.23 with its HEVC decoder (libde265) compiled to
WebAssembly. Only the ES-module bundle with the WASM embedded (`libheif-js/libheif-wasm/libheif-bundle.mjs`, about
2 MB) is used, and only from `src/app/photo/heic.ts`, which the photo worker imports dynamically when the browser
cannot decode a photo and the file is HEIF. It is never fetched on start-up or for a JPEG.

- The browser still decodes first: Safari's native HEIC path is kept, and libheif runs only where it fails.
- libheif applies the file's rotation and mirroring (`irot`, `imir`), so the photo comes out upright, as
  `createImageBitmap(..., { imageOrientation: 'from-image' })` does for a JPEG.
- A 12 MP iPhone photo decodes in about 1 s (measured in Node: 5712 x 4284 in 1.1 s).

## Alternatives considered

- **heic-decode** (ISC), which the trace-markup project uses: a thin wrapper around the same libheif-js. Its
  browser entry loads the pure-JavaScript build of libheif; using libheif-js directly gets the faster WASM build and
  one dependency less.
- **heic2any** (MIT): bundles an older libheif (about 2.7 MB), last released 2023, converts to a JPEG blob first
  (an extra lossy encode).
- **Converting on a server** (a Vercel Function): sharp's prebuilt libvips does not decode HEVC (patents), so it
  would need libheif there too, plus uploading every photo.

## Consequences

- **Licence: libheif and libde265 are LGPL-3.0.** The library ships as its own unmodified chunk, loaded at run time,
  which is the usual way to meet the LGPL in a web app; the licence text is in the package. Someone at Perkins&Will
  should confirm this is acceptable before the editor is distributed outside the company.
- **Patents:** HEVC decoding is covered by patent pools. Decoding is done by many browsers' own libraries and by
  common open-source viewers; this is noted, not assessed.
- The photo worker's chunk graph gains one lazily loaded 2 MB chunk.
