/**
 * OpenCV (WASM) for the photo pipeline. The pipeline never imports the library itself: whoever runs it hands it
 * in once with `provideCv` (the photo worker through ./cv-browser, Node tests through `require`). That keeps the
 * 11 MB library out of anything that only imports pipeline types, and out of the test runner's module interop
 * (the Emscripten module object is a thenable, which ESM namespace wrapping trips over).
 */

/** The OpenCV.js namespace. Its typings do not cover AKAZE, CLAHE or the matchers, so it is used untyped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Cv = any
/** A `cv.Mat`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Mat = any

let provided: unknown
let ready: Promise<Cv> | null = null

/** Hand in the `@techstark/opencv-js` module (its export, or a promise of it). Call once, before the pipeline runs. */
export function provideCv(module: unknown): void {
  if (provided === module) return
  provided = module
  ready = null
}

/** Resolves once the WASM runtime is initialised. */
export function loadCv(): Promise<Cv> {
  ready ??= (async () => {
    if (!provided) throw new Error('OpenCV was not provided: call provideCv() before running the photo pipeline')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cv: Cv = (provided as any).default ?? provided
    if (cv instanceof Promise) cv = await cv
    else if (!cv.Mat) await new Promise<void>((r) => (cv.onRuntimeInitialized = () => r()))
    return cv
  })()
  return ready
}
