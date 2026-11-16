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
 *  - replace: swap elements for others in one step (the type menu: an element read as another kind or given another
 *            type, a markup stroke made an element, a type set on a sheet element). Undo puts the old ones back
 *            where they were.
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
  | { type: 'replace'; removed: Replaced; added: { decisions: AcceptedDecision[]; commands: Command[] }; ink?: InkChange }

/** One element's decision and / or command, with what it becomes; either side may be empty. */
/**
 * One element changed in a replace. `stroke` (S2-02) moves ink with it: a `before.stroke` is swapped in place for the
 * `after.stroke` (a move), removed when there is none after, and an `after.stroke` with none before is added (a paste).
 */
export interface Replacement {
  before: { decision?: AcceptedDecision | null; command?: Command | null; stroke?: Stroke | null }
  after: { decision?: AcceptedDecision | null; command?: Command | null; stroke?: Stroke | null }
}

/** What a replace took out, with the index each item had, to put it back on undo. */
interface Replaced {
  decisions: { decision: AcceptedDecision; index: number }[]
  commands: { command: Command; index: number }[]
}

/** Ink a replace changed: strokes swapped in place, removed, and added. */
interface InkChange {
  swapped: { before: Stroke; after: Stroke }[]
  removed: { stroke: Stroke; index: number }[]
  added: Stroke[]
}

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

  /**
   * Replace elements in one undo step (S1 type menu). `before` items are matched by identity; ones no longer in the
   * lists are ignored. `after` items are appended.
   */
  replace(changes: readonly Replacement[]): void {
    if (!changes.length) return
    const outD = new Set(changes.flatMap((c) => (c.before.decision ? [c.before.decision] : [])))
    const outC = new Set(changes.flatMap((c) => (c.before.command ? [c.before.command] : [])))
    const removed: Replaced = { decisions: [], commands: [] }
    this.acc.forEach((d, i) => outD.has(d) && removed.decisions.push({ decision: d, index: i }))
    this.cmds.forEach((c, i) => outC.has(c) && removed.commands.push({ command: c, index: i }))
    const added = {
      decisions: changes.flatMap((c) => (c.after.decision ? [c.after.decision] : [])),
      commands: changes.flatMap((c) => (c.after.command ? [c.after.command] : [])),
    }
    const ink: InkChange = { swapped: [], removed: [], added: [] }
    for (const c of changes) {
      const b = c.before.stroke
      const a = c.after.stroke
      if (b && a) ink.swapped.push({ before: b, after: a })
      else if (b) {
        const index = this.list.indexOf(b)
        if (index >= 0) ink.removed.push({ stroke: b, index })
      } else if (a) ink.added.push(a)
    }
    ink.removed.sort((x, y) => x.index - y.index)
    const inkChanged = ink.swapped.length > 0 || ink.removed.length > 0 || ink.added.length > 0
    if (!removed.decisions.length && !removed.commands.length && !added.decisions.length && !added.commands.length && !inkChanged) return
    const op: HistoryOp = { type: 'replace', removed, added, ink }
    this.applyReplace(op)
    this.push(op)
  }

  private applyReplace(op: Extract<HistoryOp, { type: 'replace' }>) {
    const outD = new Set(op.removed.decisions.map((r) => r.decision))
    const outC = new Set(op.removed.commands.map((r) => r.command))
    this.acc = [...this.acc.filter((d) => !outD.has(d)), ...op.added.decisions]
    this.cmds = [...this.cmds.filter((c) => !outC.has(c)), ...op.added.commands]
    if (op.ink) {
      const swap = new Map(op.ink.swapped.map((s) => [s.before, s.after]))
      const out = new Set(op.ink.removed.map((r) => r.stroke))
      this.list = [...this.list.filter((s) => !out.has(s)).map((s) => swap.get(s) ?? s), ...op.ink.added]
    }
  }

  private undoReplace(op: Extract<HistoryOp, { type: 'replace' }>) {
    const inD = new Set(op.added.decisions)
    const inC = new Set(op.added.commands)
    const acc = this.acc.filter((d) => !inD.has(d))
    const cmds = this.cmds.filter((c) => !inC.has(c))
    // ascending original indices: each insert lands where the item was
    for (const r of op.removed.decisions) acc.splice(Math.min(r.index, acc.length), 0, r.decision)
    for (const r of op.removed.commands) cmds.splice(Math.min(r.index, cmds.length), 0, r.command)
    this.acc = acc
    this.cmds = cmds
    if (op.ink) {
      const back = new Map(op.ink.swapped.map((s) => [s.after, s.before]))
      const inS = new Set(op.ink.added)
      const list = this.list.filter((s) => !inS.has(s)).map((s) => back.get(s) ?? s)
      for (const r of op.ink.removed) list.splice(Math.min(r.index, list.length), 0, r.stroke)
      this.list = list
    }
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
    } else if (op.type === 'replace') this.undoReplace(op)
    else if (op.type === 'commitMany') {
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
    } else if (op.type === 'replace') this.applyReplace(op)
    else if (op.type === 'commitMany') {
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
    this.seen = highestNumber(this.cmds)
  }

  /**
   * The highest command number this history ever held, undone ones included: a command undone while Revit has it
   * waits for its revert under that id, so the id must never be handed out again (nextCommandId's floor).
   */
  highestCommandNumber(): number {
    return Math.max(this.seen, highestNumber(this.cmds))
  }

  private seen = 0

  private push(op: HistoryOp) {
    this.undoStack.push(op)
    this.redoStack = []
    this.seen = Math.max(this.seen, highestNumber(this.cmds))
  }
}

function highestNumber(commands: readonly Command[]): number {
  let n = 0
  for (const c of commands) {
    const m = /-(\d+)$/.exec(c.id)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return n
}

/**
 * Next command id after the ones in `commands` (`cmd-0001`, ... like core/commands CommandLog). `floor`: the highest
 * number ever issued (StrokeHistory.highestCommandNumber), so the id of an undone command is not handed out again.
 */
export function nextCommandId(commands: readonly Command[], prefix = 'cmd', floor = 0): string {
  const n = Math.max(floor, highestNumber(commands))
  return `${prefix}-${String(n + 1).padStart(4, '0')}`
}
