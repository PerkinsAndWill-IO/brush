/**
 * S2-07: moving and copy/pasting on the board, between the Select tool's gestures and the pure builders
 * (moveDrawn, moveHost). One `session.replaceElements` per drop or paste = one undo step.
 */
import type { Command, ContextItem, Path, Point, SheetContext } from '@core/types'
import { ptPerMetre, withSessionElements } from '@core/context'
import { SpatialIndex } from '@core/geometry'
import { nextCommandId, type Replacement } from '../board/history'
import { getSession, session } from '../session'
import { getDocState } from '../store'
import { contextNow, emptyContext } from '../brain/contextStore'
import { entryFor } from '../revit/controller'
import { itemsOf } from '../drawing/inspect'
import { copyDrawn, moveDrawn, pasteDrawn, type DrawnClip } from './moveDrawn'
import { moveHost, pasteHost, slideAlongWall, snapDrag, type HostClip } from './moveHost'
import { elementBox, resolveSelection, selection, type Resolved } from './selection'

const ASSUMED_SCALE = 100

function ctxOf(sheetId: string): SheetContext {
  const s = getSession()
  return withSessionElements(contextNow(sheetId) ?? emptyContext(sheetId), s.commands, { palette: getDocState().source?.palette, skipStrokes: s.hidden })
}

function ptPerMOf(sheetId: string): number {
  const scale = contextNow(sheetId)?.scale ?? getDocState().sheets.find((x) => x.id === sheetId)?.scale
  return ptPerMetre(scale && scale > 0 ? scale : ASSUMED_SCALE)
}

/** Fresh command ids for one batch (never reusing an undone one's, PR #67). */
function ids(): () => string {
  const { commands, commandPrefix, commandSeq } = getSession()
  let n = Number(/-(\d+)$/.exec(nextCommandId(commands, commandPrefix, commandSeq))?.[1] ?? 1)
  return () => `${commandPrefix}-${String(n++).padStart(4, '0')}`
}

let strokeSeq = 0
const newStrokeId = () => `s${Date.now().toString(36)}p${(strokeSeq++).toString(36)}`

// ───────────── what a drag moves ─────────────

export interface MoveSession {
  sheetId: string
  at: Point
  rs: Resolved[]
  /** Wall ends that snap while dragging, at the start. */
  ends: Point[]
  /** The other walls, to snap to. */
  lines: SpatialIndex
  /** One door alone: its wall, to slide along. */
  doorWall: Path | null
}

const wallItemOf = (ctx: SheetContext, ref: string): ContextItem | undefined =>
  ctx.items.find((i) => i.kind === 'wall' && (i.hostRef === ref || i.id === ref))

/** Start moving the selection (the pressed element is in it), grabbed at `at` on `sheetId`. */
export function beginMove(sheetId: string, at: Point): MoveSession | null {
  const rs = resolveSelection().filter((r) => r.sheetId === sheetId)
  if (!rs.length) return null
  const ctx = ctxOf(sheetId)
  const s = getSession()
  const movingRefs = new Set<string>()
  const ends: Point[] = []
  for (const r of rs) {
    if (r.t === 'drawn') {
      const cmd = s.commands.find((c) => c.strokeId === r.strokeId)
      if (cmd) movingRefs.add(cmd.id)
      if (r.kind === 'wall' && r.decision) {
        const pts = r.decision.geometry.points
        if (pts.length >= 2) ends.push(pts[0], pts[pts.length - 1])
      }
    } else {
      movingRefs.add(r.id)
      const w = wallItemOf(ctx, r.id)
      if (w && w.geometry.points.length >= 2) ends.push(w.geometry.points[0], w.geometry.points[w.geometry.points.length - 1])
    }
  }
  const others = ctx.items.filter((i) => (i.kind === 'wall' || i.kind === 'grid') && !movingRefs.has(i.hostRef ?? i.id))
  let doorWall: Path | null = null
  if (rs.length === 1) {
    const r = rs[0]
    if (r.t === 'drawn' && r.kind === 'door' && r.decision?.targets?.[0]) doorWall = wallItemOf(ctx, r.decision.targets[0])?.geometry ?? null
    if (r.t === 'sheet' && /^doors?$|^windows?$/i.test(r.category)) {
      const opening = ctx.items.find((i) => i.hostRef === r.id && i.props?.hostWall)
      doorWall = opening?.props?.hostWall ? (wallItemOf(ctx, opening.props.hostWall)?.geometry ?? null) : null
    }
  }
  return { sheetId, at, rs, ends, lines: new SpatialIndex(others), doorWall }
}

const isDoorSession = (m: MoveSession) =>
  m.rs.length === 1 && ((m.rs[0].t === 'drawn' && m.rs[0].kind === 'door') || (m.rs[0].t === 'sheet' && /^doors?$|^windows?$/i.test(m.rs[0].category)))

/** The offset the selection really takes for a drag of (dx, dy): doors slide along their wall, walls snap (not with `free`). */
export function constrainMove(m: MoveSession, dx: number, dy: number, free: boolean): { dx: number; dy: number } {
  if (isDoorSession(m)) return slideAlongWall(dx, dy, m.doorWall)
  return snapDrag(m.ends, dx, dy, m.lines, getSession().settings.snapRadiusPt, free)
}

/** Drop: move the selection by (dx, dy), as one undo step. */
export function endMove(m: MoveSession, dx: number, dy: number): void {
  selection.setDrag(null)
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return
  const s = getSession()
  const next = ids()
  const drawn = m.rs.filter((r): r is Extract<Resolved, { t: 'drawn' }> => r.t === 'drawn').map((r) => r.strokeId)
  const host = m.rs.filter((r): r is Extract<Resolved, { t: 'sheet' }> => r.t === 'sheet').map((r) => r.id)
  const changes: Replacement[] = [
    ...(drawn.length ? moveDrawn(s, drawn, dx, dy, next, ctxOf) : []),
    ...(host.length ? moveHost(s.commands, m.sheetId, host, m.at, dx, dy, next) : []),
  ]
  session.replaceElements(changes)
}

// ───────────── copy / paste ─────────────

let clip: { drawn: DrawnClip | null; host: HostClip | null; copies: number } = { drawn: null, host: null, copies: 0 }

/** Ctrl+C: keep the selection. Returns whether anything was copied. */
export function copySelection(): boolean {
  const rs = resolveSelection()
  if (!rs.length) return false
  const s = getSession()
  const drawn = rs.filter((r): r is Extract<Resolved, { t: 'drawn' }> => r.t === 'drawn')
  const host = rs.filter((r): r is Extract<Resolved, { t: 'sheet' }> => r.t === 'sheet')
  const sheetId = rs[0].sheetId
  let hostClip: HostClip | null = null
  if (host.length) {
    const vp = getDocState().source?.vectorPage?.(host[0].sheetId)
    const box = vp ? elementBox(itemsOf(vp.page, host.map((h) => h.id))) : null
    if (box) hostClip = { sheetId: host[0].sheetId, at: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, elementIds: host.map((h) => h.id), categories: host.map((h) => h.category) }
  }
  clip = { drawn: drawn.length ? copyDrawn(s, drawn.map((d) => d.strokeId), ptPerMOf(sheetId)) : null, host: hostClip, copies: clip.copies }
  return !!(clip.drawn?.items.length || clip.host)
}

/** Ctrl+V: paste the clipboard with its centre at `cursor` on `sheetId`, as one undo step. */
export function pasteAt(sheetId: string, cursor: Point): void {
  if (!clip.drawn?.items.length && !clip.host) return
  const next = ids()
  const changes: Replacement[] = []
  if (clip.drawn?.items.length) changes.push(...pasteDrawn(clip.drawn, sheetId, cursor, ptPerMOf(sheetId), newStrokeId, next, ctxOf))
  if (clip.host) {
    const r = pasteHost(clip.host, sheetId, cursor, ptPerMOf(sheetId), ctxOf(sheetId), (id) => entryFor(id)?.status === 'applied', ++clip.copies, next)
    if ('refused' in r) selection.notice(r.refused)
    else changes.push({ before: {}, after: { command: r.command } })
  }
  if (changes.length) session.replaceElements(changes)
}

/** Host `copy` commands pasted on `sheetId` that Revit has not confirmed: their copies cannot be grabbed yet. */
export function pendingCopiesOn(sheetId: string): Extract<Command, { op: 'copy' }>[] {
  return getSession().commands.filter((c): c is Extract<Command, { op: 'copy' }> => c.op === 'copy' && c.toSheetId === sheetId && !entryFor(c.id)?.landed)
}

/** Host `move` commands Revit has not redrawn yet. */
export function pendingMovesOn(sheetId: string): Extract<Command, { op: 'move' }>[] {
  return getSession().commands.filter((c): c is Extract<Command, { op: 'move' }> => c.op === 'move' && c.sheetId === sheetId && !entryFor(c.id)?.landed)
}

