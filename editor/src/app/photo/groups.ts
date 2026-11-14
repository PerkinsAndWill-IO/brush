/**
 * Photo-import groups (P1-07). Every import gives its strokes ids `<prefix><n>` with a prefix of its own
 * (`p<time><seq>-`, see import.ts), so the group of a stroke is read from its id: nothing extra is stored, and the
 * groups survive the sidecar and a reload. Hand-drawn strokes (`s…`) belong to no group. PURE: no DOM.
 */
import type { AcceptedDecision, Stroke } from '@core/types'

const PHOTO_ID = /^(p[0-9a-z]+-)\d+$/

/** The import a stroke came from (its id prefix), or undefined for a stroke drawn by hand. */
export function photoGroupOf(strokeId: string): string | undefined {
  return PHOTO_ID.exec(strokeId)?.[1]
}

export interface PhotoGroup {
  /** The id prefix shared by the group's strokes. */
  id: string
  sheetId: string
  strokeIds: string[]
  /** Epoch ms of the import. */
  startedAt?: number
  /** Strokes of the group that became elements. */
  elements: number
  /** Distinct ink colours, in first-seen order. */
  colors: string[]
}

/** The photo imports in the session, in the order they were made. */
export function photoGroups(strokes: readonly Stroke[], accepted: readonly AcceptedDecision[]): PhotoGroup[] {
  const done = new Set(accepted.map((a) => a.strokeId))
  const groups = new Map<string, PhotoGroup>()
  for (const s of strokes) {
    const id = photoGroupOf(s.id)
    if (!id) continue
    let g = groups.get(id)
    if (!g) groups.set(id, (g = { id, sheetId: s.sheetId, strokeIds: [], startedAt: s.startedAt, elements: 0, colors: [] }))
    g.strokeIds.push(s.id)
    if (done.has(s.id)) g.elements++
    if (s.color && !g.colors.includes(s.color)) g.colors.push(s.color)
  }
  return [...groups.values()]
}
