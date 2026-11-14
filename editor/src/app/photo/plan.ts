/**
 * Decisions around a photo import that need no pixels. PURE: no DOM, no OpenCV.
 */
import type { Sheet } from '@core/types'

/** Resolution of the quick "which sheet is this?" render. */
export const PROBE_DPI = 50
/**
 * Fewest tiles of the sheet that must lock onto the photo for "the photo shows this sheet" (same bar as the
 * registration). Tiles, not feature matches: they also lock when the print is drawn in another style than the app
 * draws the sheet.
 */
export const MIN_TILES = 12
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

/**
 * The sheet the photo shows: the candidate whose drawing locks onto the photo in the most tiles, if any reaches the
 * bar. Every candidate is compared. Sheets of one project look alike (same title block, same grid), so a wrong
 * sheet can match well too; only the best match is trusted, however good an earlier one looked. Ties go to the
 * earlier candidate (the likelier one).
 */
export function pickSheet<P extends { tiles: number }>(results: readonly { sheet: Sheet; probe: P | null }[], minTiles = MIN_TILES): { sheet: Sheet; probe: P } | null {
  let best: { sheet: Sheet; probe: P } | null = null
  for (const { sheet, probe } of results) if (probe && probe.tiles >= minTiles && (!best || probe.tiles > best.probe.tiles)) best = { sheet, probe }
  return best
}

/** A remembered sheet choice, if that sheet is in the open document; otherwise undefined (find it automatically). */
export function knownSheetId(sheets: readonly Sheet[], sheetId: string | undefined): string | undefined {
  return sheetId && sheets.some((s) => s.id === sheetId) ? sheetId : undefined
}
