/**
 * Decisions around a photo import that need no pixels. PURE: no DOM, no OpenCV.
 */
import type { Sheet } from '@core/types'

/** Resolution of the quick "which sheet is this?" render. */
export const PROBE_DPI = 50
/** Fewest consistent feature matches that count as "the photo shows this sheet" (same bar as the registration). */
export const MIN_INLIERS = 12
/** With this many matches the sheet is certain: stop trying the others. */
export const SURE_INLIERS = 150
/** Automatic sheet detection tries at most this many sheets. */
export const MAX_AUTO_SHEETS = 16
/** Long side of the working raster, px. Bounds memory in the browser (the pipeline holds several copies). */
export const MAX_WORK_SIDE = 4800

/** "A102 Plans" */
export const sheetLabel = (s: Sheet): string => [s.number, s.name].filter(Boolean).join(' ')

/**
 * Working resolution for a photo that resolves `seenDpi` on the sheet: about twice that (more adds nothing, less
 * loses edges), within 36..150 dpi and the raster cap.
 */
export function workingDpi(seenDpi: number, sizePt: { w: number; h: number }, maxSide = MAX_WORK_SIDE): number {
  let dpi = Math.max(36, Math.min(150, Math.round(seenDpi) * 2))
  const longSide = (Math.max(sizePt.w, sizePt.h) / 72) * dpi
  if (longSide > maxSide) dpi = Math.floor((dpi * maxSide) / longSide)
  return dpi
}

/** Sheets to try, the likeliest first: the one named, else the active sheet and then the rest in order. */
export function candidateSheets(sheets: readonly Sheet[], sheetId: string | undefined, activeSheetId: string | null, max = MAX_AUTO_SHEETS): Sheet[] {
  if (sheetId) return sheets.filter((s) => s.id === sheetId)
  const active = sheets.find((s) => s.id === activeSheetId)
  return [...(active ? [active] : []), ...sheets.filter((s) => s !== active)].slice(0, max)
}
