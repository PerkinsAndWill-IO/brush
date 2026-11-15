/**
 * "Make elements" for a photo import (P1-08): read imported strokes with the same first pass the live brush uses
 * (core/predict StrokeSession: the points replayed, then pen-up) and keep what the brush would commit on its own.
 * PURE: no DOM; the app glue (context, palette, session) is in ./groupActions.ts.
 *
 * The brush's three outcomes, with no one to tap a chip:
 *  - confidence >= chipHigh (or a forced mode): the element is committed, like an auto-commit
 *  - chipLow <= confidence < chipHigh: the brush would offer two chips; here the stroke stays ink ("unsure")
 *  - markup, or below chipLow: the stroke stays ink
 * Each traced stroke is read on its own: the import has no pen timing to group gestures by.
 *
 * Compound edits (C1): a photo often holds a new wall and the door in it. The strokes are read in two passes: the
 * walls first, then every other stroke against the sheet plus those new walls (core/context withSessionElements),
 * so a door on a new wall is hosted in it. Walls come first in the result, so their commands are applied before the
 * doors that name them; numberCommands rewrites the provisional ids those doors use.
 */
import type { AcceptedDecision, BrushSettings, Command, DecisionKind, SheetContext, Stroke } from '@core/types'
import { commandFromDecision } from '@core/commands'
import { StrokeSession, chipsFor, type PredictorOptions } from '@core/predict'
import { withSessionElements } from '@core/context'
import { nextCommandId } from '../board/history'

export type ReadOutcome = 'element' | 'unsure' | 'ink'

export interface ReadStrokesResult {
  /** Committed readings, in stroke order, each with its command (null for kinds that emit none). */
  decisions: { decision: AcceptedDecision; command: Command | null }[]
  outcomes: Map<string, ReadOutcome>
  /** Elements per kind. */
  byKind: Partial<Record<DecisionKind, number>>
}

export interface ReadStrokesOptions {
  palette?: PredictorOptions['palette']
  /** Accepted decisions before these strokes (sequence priors); the new ones are appended as they are made. */
  history?: readonly AcceptedDecision[]
  /** Command id for the next element (called once per command). Ids are final only via numberCommands. */
  nextCommandId?: () => string
  /** Epoch ms recorded on the decisions. */
  committedAt: number
}

/** Read one stroke the way the live brush does, up to pen-up. */
export function readStroke(stroke: Stroke, ctx: SheetContext, settings: BrushSettings, opts: PredictorOptions = {}) {
  const session = new StrokeSession({ ...stroke, points: [] }, ctx, settings, opts)
  for (const p of stroke.points) session.addPoint(p)
  const hypothesis = session.end()
  return { session, hypothesis }
}

export function readStrokes(strokes: readonly Stroke[], ctx: SheetContext, settings: BrushSettings, opts: ReadStrokesOptions): ReadStrokesResult {
  const history = [...(opts.history ?? [])]
  const out: ReadStrokesResult = { decisions: [], outcomes: new Map(), byKind: {} }
  for (const stroke of strokes) {
    if (stroke.tool === 'eraser' || stroke.points.length < 2) {
      out.outcomes.set(stroke.id, 'ink')
      continue
    }
    const { session, hypothesis: h } = readStroke(stroke, ctx, settings, { palette: opts.palette, history })
    if (!h || h.kind === 'markup' || h.confidence < settings.chipLow) {
      out.outcomes.set(stroke.id, 'ink')
      continue
    }
    if (chipsFor(h, settings).length) {
      out.outcomes.set(stroke.id, 'unsure')
      continue
    }
    const decision = session.commit(opts.committedAt)
    if (decision.kind === 'markup') {
      out.outcomes.set(stroke.id, 'ink')
      continue
    }
    const command = commandFromDecision(decision, opts.nextCommandId?.() ?? 'pending', ctx)
    out.decisions.push({ decision, command })
    out.outcomes.set(stroke.id, 'element')
    out.byKind[decision.kind] = (out.byKind[decision.kind] ?? 0) + 1
    history.push(decision)
  }
  return out
}

/** Provisional command id of a wall read from `strokeId`, until numberCommands gives the final one. */
export const provisionalWallId = (strokeId: string) => `new-wall:${strokeId}`

/**
 * C1 pass 1 → pass 2: the walls among `decisions` (their commands given provisional ids), and the sheet context with
 * them laid over it. Null when there are no walls (pass 1 is then the whole answer).
 */
export function newWallsContext(
  decisions: readonly { decision: AcceptedDecision; command: Command | null }[],
  ctx: SheetContext,
  palette?: PredictorOptions['palette'],
): { walls: { decision: AcceptedDecision; command: Command }[]; ctx: SheetContext } | null {
  const walls: { decision: AcceptedDecision; command: Command }[] = []
  for (const d of decisions) if (d.decision.kind === 'wall' && d.command) walls.push({ decision: d.decision, command: { ...d.command, id: provisionalWallId(d.decision.strokeId) } })
  if (!walls.length) return null
  return { walls, ctx: withSessionElements(ctx, walls.map((w) => w.command), { palette }) }
}

/**
 * Give the commands their ids after the session's `commands`, in order. Call it in the same synchronous step as the
 * commit: ids taken while reading (which yields to the UI) could collide with commands committed meanwhile by the
 * live brush or another import, and the Revit link skips a command whose id it has already applied.
 */
export function numberCommands<T extends { command: Command | null }>(items: readonly T[], commands: readonly Command[], prefix: string): T[] {
  let n = Number(/-(\d+)$/.exec(nextCommandId(commands, prefix))?.[1] ?? 1)
  const ids = new Map<string, string>()
  const numbered = items.map((it) => {
    if (!it.command) return it
    const id = `${prefix}-${String(n++).padStart(4, '0')}`
    ids.set(it.command.id, id)
    return { ...it, command: { ...it.command, id } }
  })
  // C1: a door hosted in a wall of the same batch names it by the wall's provisional id; a host that did not make
  // it into the batch (its stroke was erased meanwhile) is dropped, and the model picks the nearest wall
  return numbered.map((it) => {
    const c = it.command
    if (c?.op !== 'place_door' || !c.hostWallRef?.startsWith('new-wall:')) return it
    const host = ids.get(c.hostWallRef)
    const command = { ...c }
    if (host) command.hostWallRef = host
    else delete command.hostWallRef
    return { ...it, command }
  })
}
