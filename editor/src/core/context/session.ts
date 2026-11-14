/**
 * Compound edits (C1): what this session already did is context for its next stroke.
 *
 * The sheet context comes from the PDF or the package, so it does not know about the walls sketched since the
 * sheet was opened. `withSessionElements` lays the session's command log over it:
 *  - every `create_wall` on the sheet becomes a `wall` item whose id is the command id (`cmd-0007`), so a door
 *    drawn on a new wall finds it as its host and `place_door.hostWallRef` names that command (the Revit link
 *    resolves a `cmd-…` host to the wall it created for it, protocol.md);
 *  - items (or session walls) named by a `delete` are left out, so the brush stops reading a removed wall.
 * A new wall then also snaps to the walls sketched before it.
 *
 * PURE and cached by identity (context object + command array), so the 50 ms refresh reuses one prepared context.
 * A shape-only context (scanned page, or not built yet) stays shape-only: a few sketched walls are not enough to
 * switch the brush to the rules that expect real linework around the stroke.
 */
import type { Command, ContextItem, SheetContext } from '../types'
import { DEFAULT_PALETTE } from './palette'
import type { TypePalette } from './package-format'
import { ptPerMetre } from './scale'

/** Scale assumed for a wall's drawn thickness when the sheet has none (as core/predict does). */
const ASSUMED_SCALE = 100
/** Wall thickness when the command names no known type. */
const DEFAULT_THICKNESS_MM = 150

export interface SessionElementsOptions {
  /** Wall types, to give a session wall its type's thickness. Defaults to the built-in palette. */
  palette?: TypePalette
  /**
   * Strokes whose commands are already in the sheet itself (M6: applied by the linked model, which redrew the
   * sheet with the real walls). Their walls are left out, so a door hosts on the real wall, not a duplicate.
   */
  skipStrokes?: ReadonlySet<string>
}

/** Marks a context item that comes from this session's commands, not from the sheet. */
export const SESSION_SOURCE = 'session'

export const isSessionItem = (i: ContextItem): boolean => i.props?.source === SESSION_SOURCE

const cache = new WeakMap<SheetContext, { commands: readonly Command[]; opts: SessionElementsOptions; out: SheetContext }>()

export function withSessionElements(ctx: SheetContext, commands: readonly Command[], opts: SessionElementsOptions = {}): SheetContext {
  const hit = cache.get(ctx)
  if (hit && hit.commands === commands && hit.opts.palette === opts.palette && hit.opts.skipStrokes === opts.skipStrokes) return hit.out
  const out = build(ctx, commands, opts.palette ?? DEFAULT_PALETTE, opts.skipStrokes)
  cache.set(ctx, { commands, opts: { palette: opts.palette, skipStrokes: opts.skipStrokes }, out })
  return out
}

function build(ctx: SheetContext, commands: readonly Command[], palette: TypePalette, skip?: ReadonlySet<string>): SheetContext {
  const deleted = new Set<string>()
  for (const c of commands) if (c.op === 'delete') for (const t of c.targets) deleted.add(t)
  const ptPerM = ptPerMetre(ctx.scale && ctx.scale > 0 ? ctx.scale : ASSUMED_SCALE)
  const walls: ContextItem[] = []
  for (const c of commands) {
    if (c.op !== 'create_wall' || c.sheetId !== ctx.sheetId || deleted.has(c.id) || skip?.has(c.strokeId) || c.path.points.length < 2) continue
    const pts = c.path.points.map((p) => ({ x: p.x, y: p.y }))
    // a closed outline (a room drawn in one stroke) gets its closing side as a segment of its own
    if (c.path.closed && pts.length > 2) pts.push({ ...pts[0] })
    const mm = palette.walls.find((w) => w.name === c.wallType)?.thicknessMm ?? DEFAULT_THICKNESS_MM
    const props: Record<string, string> = { source: SESSION_SOURCE, thicknessPt: ((mm / 1000) * ptPerM).toFixed(2), strokeId: c.strokeId }
    if (c.wallType) props.typeName = c.wallType
    walls.push({ id: c.id, kind: 'wall', geometry: { points: pts, closed: false }, confidence: 1, props })
  }
  if (!walls.length && !deleted.size) return ctx
  const kept = deleted.size ? ctx.items.filter((i) => !deleted.has(i.id) && !(i.hostRef && deleted.has(i.hostRef))) : ctx.items
  if (!walls.length && kept.length === ctx.items.length) return ctx
  return { ...ctx, items: [...kept, ...walls] }
}
