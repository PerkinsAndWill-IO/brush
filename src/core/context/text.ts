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
