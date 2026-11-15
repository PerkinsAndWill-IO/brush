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

const norm = (s: string | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

/**
 * The open sheet that a page of the printed file is (P1-09): the photo was matched to the printed page, the strokes
 * go on this sheet. In order: the sheet chosen in the dialog; the sheet whose number and name appear in the printed
 * page's title (or the other way round; the one with the most such text, if only one sheet has it); the sheet at the same
 * position when both files have as many pages; the only sheet. Null when none of these settles it.
 */
export function matchPrintedSheet(
  printed: Sheet,
  printedCount: number,
  sheets: readonly Sheet[],
  sheetId?: string,
): Sheet | null {
  if (sheetId) return sheets.find((s) => s.id === sheetId) ?? null
  const title = ` ${norm(`${printed.number ?? ''} ${printed.name}`)} `
  const theirs = [printed.number, printed.name].map(norm).filter((t) => t.length >= 4)
  let best: Sheet | null = null
  let bestLen = 0
  let tie = false
  for (const s of sheets) {
    const mine = [s.number, s.name].map(norm).filter((t) => t.length >= 4)
    const text = ` ${norm(`${s.number ?? ''} ${s.name}`)} `
    // whole words only: "0001" is in "N01 0001 007", not in "10001". Every number and name found counts, so two
    // sheets with one name ("LEVEL 1") are told apart by their numbers
    const len = [...mine.filter((t) => title.includes(` ${t} `)), ...theirs.filter((t) => text.includes(` ${t} `))].reduce((n, t) => n + t.length, 0)
    if (len > bestLen) [best, bestLen, tie] = [s, len, false]
    else if (len && len === bestLen) tie = true
  }
  if (best && !tie) return best
  if (sheets.length === printedCount) return sheets.find((s) => s.pageIndex === printed.pageIndex) ?? null
  return sheets.length === 1 ? sheets[0] : null
}

/**
 * Scale from the printed page's points to the open sheet's (P1-09). The two are one sheet in two files: the same
 * layout, so only the page size may differ a little (rounding, another export). Null when their proportions differ
 * by more than 2 %: then they are not the same sheet layout.
 */
export function printedScale(from: { w: number; h: number }, to: { w: number; h: number }): { sx: number; sy: number } | null {
  const sx = to.w / from.w
  const sy = to.h / from.h
  return Math.abs(sx / sy - 1) <= 0.02 ? { sx, sy } : null
}

/** A remembered sheet choice, if that sheet is in the open document; otherwise undefined (find it automatically). */
export function knownSheetId(sheets: readonly Sheet[], sheetId: string | undefined): string | undefined {
  return sheetId && sheets.some((s) => s.id === sheetId) ? sheetId : undefined
}
