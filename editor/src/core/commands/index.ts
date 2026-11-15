/**
 * core/commands — command vocabulary and the command log (spec "Decision vocabulary":
 * wall → create_wall, door → place_door, furniture → place_instance, delete → delete,
 * markup → none). Pure and deterministic: ids come from a counter, never a clock or RNG.
 */
import type { AcceptedDecision, Command, CommandOp, DecisionKind, Point, Rect, SheetContext } from '../types'

export const COMMAND_OPS: readonly CommandOp[] = ['create_wall', 'place_door', 'place_instance', 'delete'] as const

/** The op each decision kind emits; null = none (the ink stays ink). */
export const OP_FOR_KIND: Record<DecisionKind, CommandOp | null> = {
  wall: 'create_wall',
  door: 'place_door',
  furniture: 'place_instance',
  delete: 'delete',
  markup: null,
}

/** Context item id → the host model's element id when the context came from a package. */
function hostRefOf(id: string, ctx?: SheetContext): string {
  const it = ctx?.items.find((i) => i.id === id)
  return it?.hostRef ?? id
}

const centroid = (pts: readonly Point[]): Point => {
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p.x
    y += p.y
  }
  return { x: x / pts.length, y: y / pts.length }
}

/**
 * Build the command for an accepted decision, or null when it emits none
 * (markup, a delete without targets, or degenerate geometry).
 *
 * - place_door: `at` is the middle of the opening (the decision's geometry is the
 *   opening segment on the host wall), `widthPt` its length, `angleRad` its direction.
 *   On an elevation the geometry is the door's closed outline face on; its first edge
 *   (bottom: sill line) gives `at`, `widthPt` and `angleRad`.
 * - place_instance: `at` is the footprint centre; `bbox` is the footprint in its own
 *   (unrotated) frame placed at `at` — rotate it by `angleRad` about `at` to get the
 *   footprint on the sheet.
 * - Targets / host walls are mapped to `hostRef` when the context is a package.
 */
export function commandFromDecision(d: AcceptedDecision, id: string, ctx?: SheetContext): Command | null {
  const pts = d.geometry.points
  switch (d.kind) {
    case 'markup':
      return null
    case 'wall': {
      if (pts.length < 2) return null
      const c: Command = { op: 'create_wall', id, sheetId: d.sheetId, path: { points: pts.map((p) => ({ ...p })), closed: d.geometry.closed }, strokeId: d.strokeId }
      if (d.type !== undefined) c.wallType = d.type
      return c
    }
    case 'door': {
      if (pts.length < 2) return null
      // closed outline = elevation door face on: points[0] -> points[1] is its bottom edge (the opening's width)
      const face = d.geometry.closed && pts.length >= 4
      const a = pts[0]
      const b = face ? pts[1] : pts[pts.length - 1]
      const widthPt = Math.hypot(b.x - a.x, b.y - a.y)
      if (widthPt <= 0) return null
      const c: Command = {
        op: 'place_door',
        id,
        sheetId: d.sheetId,
        at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        widthPt,
        angleRad: Math.atan2(b.y - a.y, b.x - a.x),
        strokeId: d.strokeId,
      }
      if (d.targets?.length) c.hostWallRef = hostRefOf(d.targets[0], ctx)
      if (d.type !== undefined) c.familyType = d.type
      return c
    }
    case 'furniture': {
      if (pts.length < 3) return null
      const at = centroid(pts.length >= 4 ? pts.slice(0, 4) : pts)
      let angleRad = 0
      let w: number
      let h: number
      if (pts.length === 4) {
        angleRad = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x)
        w = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
        h = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y)
      } else {
        const xs = pts.map((p) => p.x)
        const ys = pts.map((p) => p.y)
        w = Math.max(...xs) - Math.min(...xs)
        h = Math.max(...ys) - Math.min(...ys)
      }
      if (w <= 0 || h <= 0) return null
      const bbox: Rect = { x: at.x - w / 2, y: at.y - h / 2, w, h }
      const c: Command = { op: 'place_instance', id, sheetId: d.sheetId, at, bbox, angleRad, strokeId: d.strokeId }
      if (d.type !== undefined) c.family = d.type
      return c
    }
    case 'delete': {
      if (!d.targets?.length) return null
      return { op: 'delete', id, sheetId: d.sheetId, targets: d.targets.map((t) => hostRefOf(t, ctx)), strokeId: d.strokeId }
    }
  }
}

/**
 * Append-only command log with deterministic ids (`cmd-0001`, `cmd-0002`, ...).
 * Serialises to the plain array stored in the session file (`SessionFile.commands`).
 */
export class CommandLog {
  private list: Command[] = []
  private counter: number
  readonly prefix: string

  constructor(opts: { prefix?: string; commands?: readonly Command[] } = {}) {
    this.prefix = opts.prefix ?? 'cmd'
    this.counter = 0
    for (const c of opts.commands ?? []) this.add(c)
  }

  static fromJSON(commands: readonly Command[], prefix?: string): CommandLog {
    return new CommandLog({ commands, prefix })
  }

  get commands(): readonly Command[] {
    return this.list
  }

  get length(): number {
    return this.list.length
  }

  /** Next id, without consuming it. */
  peekId(): string {
    return `${this.prefix}-${String(this.counter + 1).padStart(4, '0')}`
  }

  /** Build the command for an accepted decision and append it; null (nothing logged) for markup. */
  append(decision: AcceptedDecision, ctx?: SheetContext): Command | null {
    const cmd = commandFromDecision(decision, this.peekId(), ctx)
    if (!cmd) return null
    this.counter++
    this.list.push(cmd)
    return cmd
  }

  /** Append an existing command (e.g. restored from a session file); keeps ids unique and increasing. */
  add(cmd: Command): Command {
    if (this.list.some((c) => c.id === cmd.id)) throw new Error(`CommandLog: duplicate id ${cmd.id}`)
    const m = new RegExp(`^${this.prefix}-(\\d+)$`).exec(cmd.id)
    if (m) this.counter = Math.max(this.counter, Number(m[1]))
    this.list.push(cmd)
    return cmd
  }

  /** Commands created from one stroke (undo of a stroke removes these). */
  forStroke(strokeId: string): Command[] {
    return this.list.filter((c) => c.strokeId === strokeId)
  }

  toJSON(): Command[] {
    return this.list.map((c) => JSON.parse(JSON.stringify(c)) as Command)
  }
}
