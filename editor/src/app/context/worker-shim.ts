// pdf.js (browser build) refers to `window` in a few places; inside a dedicated worker `self` is a fine stand-in.
const g = globalThis as unknown as { window?: unknown }
if (g.window === undefined) g.window = globalThis
export {}
