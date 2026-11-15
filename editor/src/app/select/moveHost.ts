/**
 * S2-04: moving and pasting host elements (the `.drawing` / Revit elements on a sheet), and snapping a drag. PURE.
 * A host move is one `move` command per element (decision 0012); a paste is one `copy`.
 */
import type { Command, Path, Point, SheetContext } from '@core/types'
import { closestPointOnSegment, snapPoint, type SpatialIndex } from '@core/geometry'
import type { Replacement } from '../board/history'

type MoveCommand = Extract<Command, { op: 'move' }>

const EPS = 1e-6

/**
 * Replacements setting one `move` per element (`strokeId: "move:<id>"`): a pending move of the element is replaced by
 * one with the summed offset (keeping its grab point); a sum of zero drops it.
 */
export function moveHost(
  commands: readonly Command[],
  sheetId: string,
  elementIds: readonly string[],
  at: Point,
  dx: number,
  dy: number,
  nextId: () => string,
): Replacement[] {
  const out: Replacement[] = []
  for (const el of elementIds) {
    const strokeId = `move:${el}`
    const pending = commands.find((c): c is MoveCommand => c.op === 'move' && c.strokeId === strokeId) ?? null
    const tx = (pending?.dx ?? 0) + dx
    const ty = (pending?.dy ?? 0) + dy
    if (Math.abs(tx) < EPS && Math.abs(ty) < EPS) {
      if (pending) out.push({ before: { command: pending }, after: {} })
      continue
    }
    const c: MoveCommand = { op: 'move', id: nextId(), sheetId: pending?.sheetId ?? sheetId, targets: [el], at: pending?.at ?? at, dx: tx, dy: ty, strokeId }
    out.push({ before: pending ? { command: pending } : {}, after: { command: c } })
  }
  return out
}

/** A door's drag offset projected onto its host wall's direction: it slides along its own wall only (none without a wall). */
export function slideAlongWall(dx: number, dy: number, wall: Path | null): { dx: number; dy: number } {
  const pts = wall?.points
  if (!pts || pts.length < 2) return { dx: 0, dy: 0 }
  const a = pts[0]
  const b = pts[pts.length - 1]
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < EPS) return { dx: 0, dy: 0 }
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  const t = dx * ux + dy * uy
  return { dx: t * ux, dy: t * uy }
}

/** What Ctrl+C keeps of host elements: where they were grabbed, their ids and categories. */
export interface HostClip {
  sheetId: string
  at: Point
  elementIds: string[]
  categories: string[]
}

const HOSTED = /^(doors?|windows?)$/i

/**
 * The `copy` for a paste at `to` on `toSheetId`, or a refusal. A door or window must land in a wall Revit has within
 * 1 m (`ptPerM` sheet points): a host wall (it has a hostRef), or a wall drawn this session that Revit applied
 * (`applied(commandId)`); it snaps onto that wall. Other elements land where the cursor is.
 */
export function pasteHost(
  clip: HostClip,
  toSheetId: string,
  to: Point,
  ptPerM: number,
  ctx: SheetContext,
  applied: (commandId: string) => boolean,
  nextN: number,
  nextId: () => string,
): { command: Command } | { refused: string } {
  let target = to
  if (clip.categories.some((c) => HOSTED.test(c))) {
    let best: { p: Point; d: number } | null = null
    for (const it of ctx.items) {
      if (it.kind !== 'wall' || !(it.hostRef || applied(it.id))) continue
      const pts = it.geometry.points
      for (let i = 0; i + 1 < pts.length; i++) {
        const c = closestPointOnSegment(to, pts[i], pts[i + 1])
        if (!best || c.distance < best.d) best = { p: c.point, d: c.distance }
      }
    }
    if (!best || best.d > ptPerM) return { refused: 'A door or window needs a wall in Revit within 1 m of where you paste it.' }
    target = best.p
  }
  const command: Command = { op: 'copy', id: nextId(), sheetId: clip.sheetId, targets: clip.elementIds.slice(), at: clip.at, toSheetId, to: target, strokeId: `copy:${nextN}` }
  return { command }
}

/**
 * Snap a drag: the smallest correction that puts one of the moved wall ends on a wall or corner within `radiusPt`
 * (snapPoint: corners and ends before lines); none when `free` (Shift held) or nothing is near.
 */
export function snapDrag(ends: readonly Point[], dx: number, dy: number, lines: SpatialIndex, radiusPt: number, free: boolean): { dx: number; dy: number } {
  if (free) return { dx, dy }
  // corners and ends win over a wall's line, as when drawing (snapPoint's own rule), then the nearer one
  let best: { cx: number; cy: number; d: number; rank: number } | null = null
  for (const e of ends) {
    const p = { x: e.x + dx, y: e.y + dy }
    const s = snapPoint(p, lines, { radius: radiusPt })
    if (s.kind === 'none') continue
    const rank = s.kind === 'on-wall' || s.kind === 'on-grid' ? 1 : 0
    const d = Math.hypot(s.point.x - p.x, s.point.y - p.y)
    if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { cx: s.point.x - p.x, cy: s.point.y - p.y, d, rank }
  }
  return best ? { dx: dx + best.cx, dy: dy + best.cy } : { dx, dy }
}
