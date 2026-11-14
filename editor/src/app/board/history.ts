/**
 * Document history (M1-09, M3): strokes, accepted decisions and the command log,
 * with undo/redo. PURE: no DOM.
 *
 * Operations:
 *  - add:    one stroke
 *  - addMany: several strokes at once (an import); one undo step
 *  - erase:  a set of strokes (one eraser gesture); their accepted decisions and
 *            commands go with them and come back on undo
 *  - commit: an accepted decision (and its command, if it emits one) for a stroke.
 *            Undo removes the element and the command; the stroke's ink stays.
 *  - commitMany: several of those at once (elements made from a photo import); one undo step
 */
import type { AcceptedDecision, Command, Stroke } from '@core/types'

export interface Removed {
  stroke: Stroke
  index: number
  accepted: { decision: AcceptedDecision; index: number }[]
  commands: { command: Command; index: number }[]
}

export type HistoryOp =
  | { type: 'add'; stroke: Stroke }
  | { type: 'addMany'; strokes: Stroke[] }
  | { type: 'erase'; removed: Removed[] }
  | { type: 'commit'; decision: AcceptedDecision; command: Command | null }
  | { type: 'commitMany'; items: { decision: AcceptedDecision; command: Command | null }[] }

export class StrokeHistory {
  private list: Stroke[] = []
  private acc: AcceptedDecision[] = []
  private cmds: Command[] = []
  private undoStack: HistoryOp[] = []
  private redoStack: HistoryOp[] = []

  constructor(initial: readonly Stroke[] = [], accepted: readonly AcceptedDecision[] = [], commands: readonly Command[] = []) {
    this.reset(initial, accepted, commands)
  }

  strokes(): readonly Stroke[] {
    return this.list
  }
  accepted(): readonly AcceptedDecision[] {
    return this.acc
  }
  commands(): readonly Command[] {
    return this.cmds
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  add(stroke: Stroke): void {
    this.list = [...this.list, stroke]
    this.push({ type: 'add', stroke })
  }

  /** Add several strokes as one undo step (photo import, P1-05). */
  addMany(strokes: readonly Stroke[]): void {
    if (!strokes.length) return
    this.list = [...this.list, ...strokes]
    this.push({ type: 'addMany', strokes: strokes.slice() })
  }

  /** Accept a decision for a stroke already in the list (M3 commit). */
  commit(decision: AcceptedDecision, command: Command | null): void {
    this.acc = [...this.acc, decision]
    if (command) this.cmds = [...this.cmds, command]
    this.push({ type: 'commit', decision, command })
  }

  /** Accept several decisions as one undo step (P1-08). */
  commitMany(items: readonly { decision: AcceptedDecision; command: Command | null }[]): void {
    if (!items.length) return
    this.acc = [...this.acc, ...items.map((i) => i.decision)]
    this.cmds = [...this.cmds, ...items.flatMap((i) => (i.command ? [i.command] : []))]
    this.push({ type: 'commitMany', items: items.slice() })
  }

  /** Remove strokes by id without recording history (live erasing). Returns what was removed. */
  removeLive(ids: ReadonlySet<string>): Removed[] {
    const removed: Removed[] = []
    const keep: Stroke[] = []
    this.list.forEach((s, i) => (ids.has(s.id) ? removed.push({ stroke: s, index: i, accepted: [], commands: [] }) : keep.push(s)))
    if (!removed.length) return removed
    this.list = keep
    for (const r of removed) {
      const accKeep: AcceptedDecision[] = []
      this.acc.forEach((d, i) => (d.strokeId === r.stroke.id ? r.accepted.push({ decision: d, index: i }) : accKeep.push(d)))
      this.acc = accKeep
      const cmdKeep: Command[] = []
      this.cmds.forEach((c, i) => (c.strokeId === r.stroke.id ? r.commands.push({ command: c, index: i }) : cmdKeep.push(c)))
      this.cmds = cmdKeep
    }
    return removed
  }

  /** Record one erase gesture. `removed` indices refer to the lists at the time each item was removed. */
  commitErase(removed: Removed[]): void {
    if (!removed.length) return
    this.push({ type: 'erase', removed })
  }

  /** Erase in one step (removal + history). */
  erase(ids: ReadonlySet<string>): void {
    this.commitErase(this.removeLive(ids))
  }

  undo(): boolean {
    const op = this.undoStack.pop()
    if (!op) return false
    if (op.type === 'add') this.list = this.list.filter((s) => s.id !== op.stroke.id)
    else if (op.type === 'addMany') {
      const ids = new Set(op.strokes.map((s) => s.id))
      this.list = this.list.filter((s) => !ids.has(s.id))
    } else if (op.type === 'commit') {
      this.acc = this.acc.filter((d) => d !== op.decision)
      if (op.command) this.cmds = this.cmds.filter((c) => c !== op.command)
    } else if (op.type === 'commitMany') {
      const ds = new Set<AcceptedDecision>(op.items.map((i) => i.decision))
      const cs = new Set<Command>(op.items.flatMap((i) => (i.command ? [i.command] : [])))
      this.acc = this.acc.filter((d) => !ds.has(d))
      this.cmds = this.cmds.filter((c) => !cs.has(c))
    } else {
      const strokes = this.list.slice()
      const acc = this.acc.slice()
      const cmds = this.cmds.slice()
      // re-insert in reverse removal order so every index is valid again
      for (let i = op.removed.length - 1; i >= 0; i--) {
        const r = op.removed[i]
        for (let k = r.commands.length - 1; k >= 0; k--) cmds.splice(Math.min(r.commands[k].index, cmds.length), 0, r.commands[k].command)
        for (let k = r.accepted.length - 1; k >= 0; k--) acc.splice(Math.min(r.accepted[k].index, acc.length), 0, r.accepted[k].decision)
        strokes.splice(Math.min(r.index, strokes.length), 0, r.stroke)
      }
      this.list = strokes
      this.acc = acc
      this.cmds = cmds
    }
    this.redoStack.push(op)
    return true
  }

  redo(): boolean {
    const op = this.redoStack.pop()
    if (!op) return false
    if (op.type === 'add') this.list = [...this.list, op.stroke]
    else if (op.type === 'addMany') this.list = [...this.list, ...op.strokes]
    else if (op.type === 'commit') {
      this.acc = [...this.acc, op.decision]
      if (op.command) this.cmds = [...this.cmds, op.command]
    } else if (op.type === 'commitMany') {
      this.acc = [...this.acc, ...op.items.map((i) => i.decision)]
      this.cmds = [...this.cmds, ...op.items.flatMap((i) => (i.command ? [i.command] : []))]
    } else {
      const ids = new Set(op.removed.map((r) => r.stroke.id))
      this.list = this.list.filter((s) => !ids.has(s.id))
      this.acc = this.acc.filter((d) => !ids.has(d.strokeId))
      this.cmds = this.cmds.filter((c) => !ids.has(c.strokeId))
    }
    this.undoStack.push(op)
    return true
  }

  reset(strokes: readonly Stroke[] = [], accepted: readonly AcceptedDecision[] = [], commands: readonly Command[] = []): void {
    this.list = strokes.slice()
    this.acc = accepted.slice()
    this.cmds = commands.slice()
    this.undoStack = []
    this.redoStack = []
  }

  private push(op: HistoryOp) {
    this.undoStack.push(op)
    this.redoStack = []
  }
}

/** Next command id after the ones in `commands` (`cmd-0001`, ... like core/commands CommandLog). */
export function nextCommandId(commands: readonly Command[], prefix = 'cmd'): string {
  let n = 0
  for (const c of commands) {
    const m = /-(\d+)$/.exec(c.id)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return `${prefix}-${String(n + 1).padStart(4, '0')}`
}
