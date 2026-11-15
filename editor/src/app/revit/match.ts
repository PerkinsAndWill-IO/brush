/**
 * M6-11: is the file the user opened the model that is open in Revit? PURE: the controller feeds it what it knows
 * about the file (its name, the model file it came from, its sheets) and the link's welcome.
 *
 * Two independent signals, either is enough:
 *  - **name**: the file's name, or the model file a `.drawing` was exported from (`source.file`), is the name of the
 *    Revit document (its title or the file name in its path). Case, extensions (`.drawing`, `.rvt`, `.json`), a
 *    browser's " (1)" download suffix and punctuation are ignored.
 *  - **sheets**: every sheet of the file has a Revit sheet with the same element id and the same number. Ids and
 *    numbers both coinciding in an unrelated model is unlikely, and this survives a renamed export.
 *
 * Revit's project name (Project Information) is not used on its own: a new model is called "Project Name".
 */
import type { LinkDocument, LinkSheetSummary } from './protocol'

export interface FileFacts {
  /** File name as opened (`Tower A.drawing`, `Tower A.rvt`). */
  fileName?: string
  /** The model the file was made from, when the file says (`.drawing` `source.file`, package `project`). */
  model?: string
  /** The file's sheets. Empty for a `.rvt` that was not converted. */
  sheets: readonly { id: string; number?: string }[]
}

export interface FileMatch {
  matches: boolean
  by?: 'name' | 'sheets'
  /** Revit sheet ids of the file's sheets, in the file's order (matched by id, else by number). */
  sheetIds: string[]
}

/** "C:\\Models\\Tower A (1).drawing" → "towera". */
export function nameKey(name: string | undefined | null): string {
  if (!name) return ''
  let n = name.split(/[\\/]/).pop() ?? ''
  for (let prev = ''; prev !== n; ) {
    prev = n
    n = n.replace(/\.(drawing|rvt|rfa|json|zip|pdf)$/i, '')
  }
  n = n.replace(/\s*\(\d+\)$/, '')
  return n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function matchFile(file: FileFacts, doc: LinkDocument | null, sheets: readonly LinkSheetSummary[]): FileMatch {
  if (!doc) return { matches: false, sheetIds: [] }
  const revitKeys = new Set([nameKey(doc.title), nameKey(doc.path)].filter(Boolean))
  const fileKeys = [nameKey(file.fileName), nameKey(file.model)].filter(Boolean)
  const byName = fileKeys.some((k) => revitKeys.has(k))

  const byId = new Map(sheets.map((s) => [s.id, s]))
  const byNumber = new Map(sheets.filter((s) => s.number).map((s) => [s.number!.toLowerCase(), s]))
  const exact = file.sheets.filter((s) => byId.get(s.id) && (byId.get(s.id)!.number ?? '') === (s.number ?? ''))
  const bySheets = file.sheets.length > 0 && exact.length === file.sheets.length

  const ids: string[] = []
  for (const s of file.sheets) {
    const r = byId.get(s.id) ?? (s.number ? byNumber.get(s.number.toLowerCase()) : undefined)
    if (r && !ids.includes(r.id)) ids.push(r.id)
  }
  if (byName) return { matches: true, by: 'name', sheetIds: ids }
  if (bySheets) return { matches: true, by: 'sheets', sheetIds: ids }
  return { matches: false, sheetIds: [] }
}
