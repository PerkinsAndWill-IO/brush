/**
 * S2-03: moving and pasting elements drawn this session. PURE: builds the replacements (S1-05 / S2-02) that one
 * `session.replaceElements` call applies as one undo step. Ink, decision and command change together; a command gets
 * a new id (Revit reverts the old one and applies the new one).
 */
import type { AcceptedDecision, Command, Point, SheetContext, Stroke } from '@core/types'
import { commandFromDecision } from '@core/commands'
import type { Replacement } from '../board/history'

export interface DrawnState {
  strokes: readonly Stroke[]
  accepted: readonly AcceptedDecision[]
  commands: readonly Command[]
}

const shiftStroke = (s: Stroke, f: (p: Point) => Point, extra: Partial<Stroke> = {}): Stroke => ({
  ...s,
  ...extra,
  points: s.points.map((p) => ({ ...p, ...f(p) })),
})
const shiftDecision = (d: AcceptedDecision, f: (p: Point) => Point, extra: Partial<AcceptedDecision> = {}): AcceptedDecision => ({
  ...d,
  ...extra,
  geometry: { points: d.geometry.points.map(f), closed: d.geometry.closed },
})
const ownCommand = (s: DrawnState, strokeId: string) => s.commands.find((c) => c.strokeId === strokeId) ?? null

/**
 * Replacements moving drawn strokes `strokeIds` by (dx, dy) sheet points. Drawn doors hosted in a moved drawn wall
 * (their decision targets the wall's command) move too, and point at the wall's new command.
 */
export function moveDrawn(
  s: DrawnState,
  strokeIds: readonly string[],
  dx: number,
  dy: number,
  nextId: () => string,
  ctxOf: (sheetId: string) => SheetContext,
): Replacement[] {
  const moving = new Set(strokeIds)
  // walls' commands → the strokes whose doors follow them
  const wallCmds = new Map<string, string>()
  for (const id of moving) {
    const c = ownCommand(s, id)
    if (c?.op === 'create_wall') wallCmds.set(c.id, id)
  }
  for (const d of s.accepted) if (d.kind === 'door' && d.targets?.some((t) => wallCmds.has(t))) moving.add(d.strokeId)

  const f = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy })
  const renamed = new Map<string, string>() // old wall command id → new one
  const out: Replacement[] = []
  // walls first, so their doors can point at the new ids
  const order = [...moving].sort((a, b) => Number(!wallCmds.has(ownCommand(s, a)?.id ?? '')) - Number(!wallCmds.has(ownCommand(s, b)?.id ?? '')))
  for (const id of order) {
    const stroke = s.strokes.find((x) => x.id === id)
    const decision = s.accepted.find((x) => x.strokeId === id) ?? null
    if (!stroke) continue
    const command = ownCommand(s, id)
    const after: Replacement['after'] = { stroke: shiftStroke(stroke, f) }
    if (decision) {
      const targets = decision.targets?.map((t) => renamed.get(t) ?? t)
      const d = shiftDecision(decision, f, targets ? { targets } : {})
      after.decision = d
      const c = commandFromDecision(d, nextId(), ctxOf(d.sheetId))
      after.command = c
      if (command && c) renamed.set(command.id, c.id)
    }
    out.push({ before: { stroke, decision, command }, after })
  }
  return out
}

/** What Ctrl+C keeps of drawn elements: strokes and decisions, the group's centre, and the sheet's scale. */
export interface DrawnClip {
  /** `commandId`: the copied element's command, so a pasted door can point at the pasted copy of its wall. */
  items: { stroke: Stroke; decision: AcceptedDecision; commandId?: string }[]
  centre: Point
  ptPerM: number
}

export function copyDrawn(s: DrawnState, strokeIds: readonly string[], ptPerM: number): DrawnClip {
  const items: DrawnClip['items'] = []
  for (const id of strokeIds) {
    const stroke = s.strokes.find((x) => x.id === id)
    const decision = s.accepted.find((x) => x.strokeId === id)
    if (!stroke || !decision) continue
    const commandId = ownCommand(s, id)?.id
    items.push(commandId ? { stroke, decision, commandId } : { stroke, decision })
  }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const { decision } of items)
    for (const p of decision.geometry.points) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
  const centre = items.length ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : { x: 0, y: 0 }
  return { items, centre, ptPerM }
}

/**
 * Replacements adding the clip with its centre on `cursor` on `sheetId`, scaled by the sheets' scales so it keeps its
 * real-world size, with new stroke ids and command ids. A pasted door hosted in a pasted wall points at the new wall.
 */
export function pasteDrawn(
  clip: DrawnClip,
  sheetId: string,
  cursor: Point,
  ptPerM: number,
  newStrokeId: () => string,
  nextId: () => string,
  ctxOf: (sheetId: string) => SheetContext,
): Replacement[] {
  const k = clip.ptPerM > 0 && ptPerM > 0 ? ptPerM / clip.ptPerM : 1
  const f = (p: Point): Point => ({ x: cursor.x + (p.x - clip.centre.x) * k, y: cursor.y + (p.y - clip.centre.y) * k })
  const ctx = ctxOf(sheetId)
  const renamed = new Map<string, string>() // copied wall's command id → pasted wall's command id
  const out: Replacement[] = []
  const walls = clip.items.filter((i) => i.decision.kind === 'wall')
  const rest = clip.items.filter((i) => i.decision.kind !== 'wall')
  for (const { stroke, decision, commandId } of [...walls, ...rest]) {
    const sid = newStrokeId()
    const targets = decision.targets?.map((t) => renamed.get(t) ?? t)
    const d = shiftDecision(decision, f, { strokeId: sid, sheetId, ...(targets ? { targets } : {}) })
    const c = commandFromDecision(d, nextId(), ctx)
    if (decision.kind === 'wall' && c && commandId) renamed.set(commandId, c.id)
    out.push({ before: {}, after: { stroke: shiftStroke(stroke, f, { id: sid, sheetId }), decision: d, command: c } })
  }
  return out
}
