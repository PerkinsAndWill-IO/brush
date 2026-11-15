/**
 * Photo of hand markup on a printed sheet -> vector strokes in sheet coordinates.
 * A port of the trace-markup project's pipeline (register -> isolate -> trace) that takes plain rasters, so it
 * runs in the photo worker and in Node tests. OpenCV is handed in with `provideCv` (see ./cv); the main thread
 * imports types only.
 *
 *   register  the photo is matched to a render of the sheet (features, then tiles, then a wrinkle field)
 *   isolate   whatever the drawing cannot explain is ink; it is split into one layer per pen colour
 *   trace     each layer becomes centreline strokes with a pen width; marker fills become outlines
 */
import { loadCv } from './cv'
import { isolateMarkup } from './isolate'
import { traceOutlines } from './outline'
import type { Log, RgbImage } from './raster'
import { probePhoto, registerPhoto, type Probe, type RegistrationReport, type Seed } from './register'
import { centrelines } from './strokes'

export type { Probe, RegistrationReport, Seed } from './register'
export { SheetProbe, preparePhoto, releasePhoto } from './register'
export type { RgbImage } from './raster'

export type InkChoice = 'both' | 'color' | 'dark'

export interface MarkupOptions {
  /** Which markup to pick up: coloured pens and markers, black pen and pencil, or both (default). */
  ink?: InkChoice
  /** How saturated a pixel must be to count as coloured ink, 0..1 (default 0.2). */
  colorThresh?: number
  /** How dark a pixel must be to count as black ink, 0..1 (default 0.28). */
  darkThresh?: number
  /** Ignore specks smaller than about this many pixels (default 40). */
  minArea?: number
  /**
   * Ignore objects lying on the sheet (pens, a hand): solid areas thicker than about this percentage of the
   * sheet's long side (default 1.2). 0 keeps everything.
   */
  maxStroke?: number
  /** Skip the wrinkle correction (feature-based registration only). */
  refine?: boolean
  /** Where the probe found the sheet in the photo: the registration starts there instead of matching features again. */
  seed?: Seed
  log?: Log
}

/** A pen stroke in sheet points (origin top-left, y down). */
export interface MarkupStroke {
  points: [number, number][]
  /** Pen width in sheet points. */
  width: number
  closed: boolean
  /** True for the outline of a filled area (marker fill), which has no pen width of its own. */
  outline?: boolean
}

/** Everything drawn with one pen. */
export interface MarkupLayer {
  /** "black", or the colour family ("red", "blue", "green2", ...). */
  name: string
  /** Ink colour, 0..255 per channel. */
  color: [number, number, number]
  strokes: MarkupStroke[]
}

export interface MarkupResult {
  layers: MarkupLayer[]
  report: RegistrationReport
  /** Working raster of the sheet. */
  sheet: { w: number; h: number; dpi: number }
}

/** Quick feature-only match of the photo against a low-resolution render: is this the sheet, and how sharp is the photo on it? */
export function probe(photo: RgbImage, ref: RgbImage, refDpi: number, log?: Log): Promise<Probe | null> {
  return probePhoto(photo, ref, refDpi, log)
}

/**
 * @param photo the photo, upright
 * @param ref the sheet rendered at `dpi` (white paper, the drawing as printed)
 * @param dpi resolution of `ref`: pixels per inch of sheet
 */
export async function photoToMarkup(photo: RgbImage, ref: RgbImage, dpi: number, opts: MarkupOptions = {}): Promise<MarkupResult> {
  const { ink = 'both', colorThresh, darkThresh, minArea, maxStroke, refine = true, seed, log = () => {} } = opts
  const cv = await loadCv()
  const pxToPt = 72 / dpi

  const reg = await registerPhoto(photo, ref, { log, refine, seed })
  const s = reg.report.scale
  log('separating the ink from the print…')
  const iso = await isolateMarkup(reg, { scale: s, ink, colorThresh, darkThresh, minArea, maxStroke, log })

  const layers: MarkupLayer[] = []
  for (const l of iso.layers) {
    // centreline strokes; anything too thick to be a pen stroke (a marker fill) becomes its outline
    const c = centrelines(l.mask, iso.w, iso.h, pxToPt, { scale: s })
    const strokes: MarkupStroke[] = c.strokes
    let fills = 0
    if (c.fillMask) {
      const outlines = traceOutlines(cv, c.fillMask, iso.w, iso.h, pxToPt, { smooth: 1.2 * s, tolerance: 0.5 * s, minArea: (minArea ?? 40) * s * s })
      fills = outlines.length
      for (const points of outlines) strokes.push({ points, width: Math.max(0.5, 1.5 * pxToPt), closed: true, outline: true })
    }
    const widths = c.strokes.map((st) => st.width).sort((a, b) => a - b)
    log(
      `layer ${l.name}: rgb(${l.color.join(',')}), ${c.strokes.length} strokes` +
        (widths.length ? ` (median width ${((widths[widths.length >> 1] / 72) * 25.4).toFixed(1)} mm on the sheet)` : '') +
        (fills ? `, ${fills} fill outlines` : ''),
    )
    if (strokes.length) layers.push({ name: l.name, color: l.color, strokes })
  }
  return { layers, report: reg.report, sheet: { w: reg.w, h: reg.h, dpi } }
}
