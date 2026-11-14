/**
 * Stroke list with undo/redo (M1-09). PURE: no DOM.
 * Operations: add one stroke, erase a set of strokes (one eraser gesture).
 * Erased strokes go back to their original positions on undo.
 */
import type { Stroke } from '@core/types'

export type HistoryOp = { type: 'add'; stroke: Stroke } | { type: 'erase'; removed: { stroke: Stroke; index: number }[] }

export class StrokeHistory {
  private list: Stroke[] = []
  private undoStack: HistoryOp[] = []
  private redoStack: HistoryOp[] = []

  constructor(initial: readonly Stroke[] = []) {
    this.list = initial.slice()
  }

  strokes(): readonly Stroke[] {
    return this.list
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  add(stroke: Stroke): void {
    this.list = [...this.list, stroke]
    this.undoStack.push({ type: 'add', stroke })
    this.redoStack = []
  }

  /** Remove strokes by id without recording history (live erasing). Returns what was removed. */
  removeLive(ids: ReadonlySet<string>): { stroke: Stroke; index: number }[] {
    const removed: { stroke: Stroke; index: number }[] = []
    const keep: Stroke[] = []
    this.list.forEach((s, i) => (ids.has(s.id) ? removed.push({ stroke: s, index: i }) : keep.push(s)))
    if (removed.length) this.list = keep
    return removed
  }

  /** Record one erase gesture. `removed` indices refer to the list at the time each stroke was removed. */
  commitErase(removed: { stroke: Stroke; index: number }[]): void {
    if (!removed.length) return
    this.undoStack.push({ type: 'erase', removed })
    this.redoStack = []
  }

  /** Erase in one step (removal + history). */
  erase(ids: ReadonlySet<string>): void {
    this.commitErase(this.removeLive(ids))
  }

  undo(): boolean {
    const op = this.undoStack.pop()
    if (!op) return false
    if (op.type === 'add') this.list = this.list.filter((s) => s.id !== op.stroke.id)
    else {
      const next = this.list.slice()
      // re-insert in reverse removal order so every index is valid again
      for (let i = op.removed.length - 1; i >= 0; i--) {
        const { stroke, index } = op.removed[i]
        next.splice(Math.min(index, next.length), 0, stroke)
      }
      this.list = next
    }
    this.redoStack.push(op)
    return true
  }

  redo(): boolean {
    const op = this.redoStack.pop()
    if (!op) return false
    if (op.type === 'add') this.list = [...this.list, op.stroke]
    else {
      const ids = new Set(op.removed.map((r) => r.stroke.id))
      this.list = this.list.filter((s) => !ids.has(s.id))
    }
    this.undoStack.push(op)
    return true
  }

  reset(strokes: readonly Stroke[] = []): void {
    this.list = strokes.slice()
    this.undoStack = []
    this.redoStack = []
  }
}
