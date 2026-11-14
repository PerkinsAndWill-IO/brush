const ROOM_BLACKLIST = new Set([
  'SCALE', 'PLAN', 'PLANS', 'NOTES', 'NOTE', 'SHEET', 'DRAWN', 'CHECKED', 'PROJECT', 'REVISION', 'REV', 'DATE',
  'TITLE', 'ELEVATION', 'ELEVATIONS', 'SECTION', 'SECTIONS', 'DETAIL', 'DETAILS', 'LEGEND', 'NORTH', 'FLOOR',
  'LEVEL', 'KEY', 'SCHEDULE', 'DIAGRAM', 'NTS', 'TYP', 'DRAWING', 'ISSUE', 'APPROVED', 'CLIENT',
])

const WORD = String.raw`[A-Z][A-Z&'./\-]*`
const ROOM_RE = new RegExp(String.raw`^(${WORD}(?: ${WORD})*)(?: (\d{1,4}[A-Z]?))?$`)

/** Room-label-ish text: uppercase words optionally followed by a number ("OFFICE 201"). */
export function isRoomLabel(s: string): boolean {
  const t = s.trim().replace(/\s+/g, ' ')
  const m = ROOM_RE.exec(t)
  if (!m) return false
  const words = m[1].split(' ')
  for (const w of words) if (ROOM_BLACKLIST.has(w.replace(/[^A-Z]/g, ''))) return false
  const letters = (m[1].match(/[A-Z]/g) ?? []).length
  return letters >= 3 || (letters >= 2 && m[2] !== undefined)
}

/** Short grid bubble label: A-Z or 1-99. */
export function isGridLabel(s: string): boolean {
  const t = s.trim()
  return /^[A-Z]$/.test(t) || /^[1-9]\d?$/.test(t)
}

/** Numeric dimension text: 3500, 3.50, 3500 mm, 12'-6". */
export function isNumericDim(s: string): boolean {
  const t = s.trim()
  return /^\(?\d{2,6}(?:[.,]\d+)?\)?(?:\s?(?:mm|cm|m))?$/i.test(t) || /^\d+'(?:\s?-?\s?\d+(?:\s\d+\/\d+)?")?$/.test(t)
}

/** "A-201", "A101", "S-3.01". */
export const SHEET_NUMBER_RE = /^[A-Z]{1,3}[-.]?\d{1,3}(?:\.\d{1,2})?[A-Z]?$/

/**
 * Structured drawing code: 4+ dash-separated alphanumeric fields with an optional " - 007" revision/suffix,
 * e.g. "KRO-APD-ARC-PLN-A1A-N01-0001 - 007", "PRJ-XX-ZZ-DR-A-1001". Must contain a letter field and a digit field.
 */
export const DRAWING_CODE_RE = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{1,8}(?:\s?[-_]\s?[A-Z0-9]{1,8}){3,9}$/

/** "KRO-APD-ARC-PLN-A1A-N01-0001 - 007" -> "KRO-APD-ARC-PLN-A1A-N01-0001-007". */
export function normalizeDrawingCode(s: string): string {
  return s.trim().replace(/\s*([-_])\s*/g, '$1')
}
