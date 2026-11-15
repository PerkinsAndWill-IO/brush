/**
 * The import's progress as the dialog tells it (P1-11): four stages read off the import's own progress lines, a
 * rotating line of patter per stage, and an estimate of how far along it is. PURE: no DOM.
 */

export type ImportStage = 'develop' | 'find' | 'align' | 'trace'
export const STAGES: readonly ImportStage[] = ['develop', 'find', 'align', 'trace']

export const STAGE_TITLE: Record<ImportStage, string> = {
  develop: 'Developing the photo',
  find: 'Finding the sheet',
  align: 'Pinning it down',
  trace: 'Tracing your lines',
}

/** The stage a progress line belongs to, or undefined for a line that does not move the stage. */
export function stageOfLine(line: string): ImportStage | undefined {
  if (/^Reading the photo|^Photo \d+ × \d+/.test(line)) return 'develop'
  if (/^Looking for the sheet|^Matching the photo to/.test(line)) return 'find'
  if (/tracing at \d+ dpi|^features|homography|wrinkle correction|^The photo shows/.test(line)) return 'align'
  if (/^separating the ink|^ignoring |^ink found|^layer /.test(line)) return 'trace'
  return undefined
}

/** Stages only move forward: a later line of an earlier stage does not take the dialog back. */
export function advanceStage(cur: ImportStage, line: string): ImportStage {
  const next = stageOfLine(line)
  return next && STAGES.indexOf(next) > STAGES.indexOf(cur) ? next : cur
}

/** "Looking for the sheet: A-201 Level 2…" -> "A-201 Level 2" (the sheet being compared), else undefined. */
export function sheetOfLine(line: string): string | undefined {
  const m = /^(?:Looking for the sheet: |Matching the photo to )(.+?)…?$/.exec(line)
  if (!m) return undefined
  // a long "number name" label is shortened to its number, so the line stays one line
  const label = m[1]
  return label.length > 32 ? label.split(' ')[0] : label
}

/** Typical share of the whole import spent in each stage (measured on the KRO photo, 3 sheets: about 2, 58, 16 and 4 s). */
const SHARE: Record<ImportStage, number> = { develop: 0.05, find: 0.55, align: 0.28, trace: 0.12 }
/** Typical seconds in each stage, for the creep inside a stage. */
const TYPICAL_S: Record<ImportStage, number> = { develop: 2, find: 30, align: 12, trace: 5 }

/**
 * How far along the import is, 0..0.97: the stages done, plus a creep inside the current one that slows down the
 * longer it takes, so the bar never stops and never claims to be done before it is.
 */
export function progressFraction(stage: ImportStage, secondsInStage: number): number {
  const i = STAGES.indexOf(stage)
  const before = STAGES.slice(0, i).reduce((a, s) => a + SHARE[s], 0)
  const creep = 1 - Math.exp(-Math.max(0, secondsInStage) / TYPICAL_S[stage])
  return Math.min(0.97, before + SHARE[stage] * 0.92 * creep)
}

const PATTER: Record<ImportStage, readonly string[]> = {
  develop: ['Letting the photo develop…', 'Shaking the polaroid (gently)…', 'Finding which way is up…'],
  find: ['Holding it up to {sheet}…', 'Squinting at the grid lines…', 'Comparing title blocks…', 'Counting the columns…'],
  align: ['Pinning down the four corners…', 'Smoothing the wrinkles out of the trace…', 'Lining up the walls, millimetre by millimetre…', 'Nudging it a hair to the left…'],
  trace: ['Following your pen…', 'Telling your ink from the print…', 'Sharpening the pencils…', 'Lifting the lines off the paper…'],
}

/** The line of patter shown `seconds` into a stage: changes every few seconds, names the sheet being compared. */
export function patter(stage: ImportStage, seconds: number, sheet?: string): string {
  const lines = PATTER[stage].filter((l) => sheet || !l.includes('{sheet}'))
  const l = lines[Math.floor(Math.max(0, seconds) / 3.5) % lines.length]
  return sheet ? l.replace('{sheet}', sheet) : l
}

/** "1:05" */
export const clock = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
