import type { AcceptedDecision, ContextItem, SheetContext } from '../types'
import { ptPerMetre } from './scale'
import { DEFAULT_PALETTE } from './palette'
import type { TypePalette } from './package-format'

/** Scale assumed for a drawn wall's thickness when the sheet has none (matches predict's ASSUMED_SCALE). */
const ASSUMED_SCALE = 100
/** Thickness (mm) for a drawn wall whose type is not in the palette. */
const FALLBACK_MM = 200

export interface DrawnWallOptions {
  /** Palette that names the drawn walls' types (thickness). Default DEFAULT_PALETTE. */
  palette?: TypePalette
  /** strokeId -> id of the create_wall command it emitted; becomes the item's hostRef. */
  refs?: ReadonlyMap<string, string>
}

/** Id of the context item that stands for a drawn (accepted) wall. */
export const drawnWallId = (strokeId: string): string => `drawn-wall-${strokeId}`

/**
 * The sheet's context plus the walls the user has drawn and accepted on it, as `wall` items, so new
 * walls snap to them and doors are placed in them like in walls read from the PDF. Pure. Returns the
 * same object when nothing was drawn on the sheet (keeps the prepared-context cache warm).
 * Shape-only (scanned) contexts stay shape-only.
 */
export function withDrawnWalls(ctx: SheetContext, accepted: readonly AcceptedDecision[], opts: DrawnWallOptions = {}): SheetContext {
  const mine = accepted.filter((a) => a.sheetId === ctx.sheetId && a.kind === 'wall' && a.geometry.points.length >= 2)
  if (!mine.length) return ctx
  const palette = opts.palette ?? DEFAULT_PALETTE
  const ptPerM = ptPerMetre(ctx.scale && ctx.scale > 0 ? ctx.scale : ASSUMED_SCALE)
  const items: ContextItem[] = mine.map((a) => {
    const mm = palette.walls.find((w) => w.name === a.type)?.thicknessMm ?? FALLBACK_MM
    const it: ContextItem = {
      id: drawnWallId(a.strokeId),
      kind: 'wall',
      geometry: { points: a.geometry.points.map((p) => ({ x: p.x, y: p.y })), closed: a.geometry.closed },
      confidence: 1,
      props: { thicknessPt: String(Math.round((mm / 1000) * ptPerM * 100) / 100), source: 'drawn', strokeId: a.strokeId },
    }
    const ref = opts.refs?.get(a.strokeId)
    if (ref) it.hostRef = ref
    return it
  })
  return { ...ctx, items: [...ctx.items, ...items] }
}
