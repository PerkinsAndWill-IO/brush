/**
 * Command sync between the session's command log and the linked model (M6-03, M6-04, M6-06). PURE: no DOM, no
 * socket; the controller feeds it the log and the plugin's replies, and sends what it plans.
 *
 * The log is the truth. Sync compares it with what the model has:
 *  - a command in the log the model has not seen      → `apply`
 *  - a command the model applied that left the log    → `revert` (undo of a commit, erase of its stroke)
 *  - a reverted command that comes back (redo)        → `apply` again (the plugin forgets reverted ids)
 *
 * A command is `landed` once a sheet version that includes it arrived: the sheet now draws the real element, so the
 * stroke that made it can be hidden. `skipped` (already applied, targets gone) counts as landed at once.
 */
import type { Command, Stroke } from '@core/types'
import type { CommandResult } from './protocol'

export type SyncStatus = 'sending' | 'applied' | 'skipped' | 'failed' | 'reverting'

export interface SyncEntry {
  id: string
  sheetId: string
  status: SyncStatus
  /** Applied and a newer sheet version arrived. */
  landed: boolean
  message?: string
  notes?: string[]
  elementIds?: string[]
}

export interface ApplyBatch {
  sheetId: string
  commands: Command[]
}
export interface RevertBatch {
  sheetId: string
  commandIds: string[]
}
export interface SyncPlan {
  apply: ApplyBatch[]
  revert: RevertBatch[]
}

export class CommandSync {
  private entries = new Map<string, SyncEntry>()

  entry(id: string): SyncEntry | undefined {
    return this.entries.get(id)
  }

  all(): SyncEntry[] {
    return [...this.entries.values()]
  }

  /**
   * What to send now. Marks planned commands `sending` / `reverting`. Only commands on `linkedSheets` take part;
   * failed commands stay failed until they leave the log (sending them again would fail the same way).
   */
  plan(log: readonly Command[], linkedSheets: ReadonlySet<string>): SyncPlan {
    const inLog = new Set(log.map((c) => c.id))
    const apply = new Map<string, Command[]>()
    for (const c of log) {
      if (!linkedSheets.has(c.sheetId) || this.entries.has(c.id)) continue
      this.entries.set(c.id, { id: c.id, sheetId: c.sheetId, status: 'sending', landed: false })
      if (!apply.has(c.sheetId)) apply.set(c.sheetId, [])
      apply.get(c.sheetId)!.push(c)
    }
    const revert = new Map<string, string[]>()
    for (const e of [...this.entries.values()]) {
      if (inLog.has(e.id)) continue
      if (e.status === 'failed') this.entries.delete(e.id)
      else if (e.status === 'applied' || e.status === 'skipped') {
        if (!linkedSheets.has(e.sheetId)) continue
        e.status = 'reverting'
        if (!revert.has(e.sheetId)) revert.set(e.sheetId, [])
        revert.get(e.sheetId)!.push(e.id)
      }
      // 'sending' / 'reverting': wait for the reply; the next plan decides
    }
    return {
      apply: [...apply].map(([sheetId, commands]) => ({ sheetId, commands })),
      revert: [...revert].map(([sheetId, commandIds]) => ({ sheetId, commandIds })),
    }
  }

  /** True when `plan` would send something (cheap check for the debounce). */
  hasWork(log: readonly Command[], linkedSheets: ReadonlySet<string>): boolean {
    const inLog = new Set(log.map((c) => c.id))
    if (log.some((c) => linkedSheets.has(c.sheetId) && !this.entries.has(c.id))) return true
    return this.all().some((e) => !inLog.has(e.id) && (e.status === 'failed' || ((e.status === 'applied' || e.status === 'skipped') && linkedSheets.has(e.sheetId))))
  }

  /** How many commands `plan` would send now (applies plus reverts), for "N edits waiting" while streaming is paused. */
  pendingCount(log: readonly Command[], linkedSheets: ReadonlySet<string>): number {
    const inLog = new Set(log.map((c) => c.id))
    const apply = log.filter((c) => linkedSheets.has(c.sheetId) && !this.entries.has(c.id)).length
    const revert = this.all().filter((e) => !inLog.has(e.id) && (e.status === 'applied' || e.status === 'skipped') && linkedSheets.has(e.sheetId)).length
    return apply + revert
  }

  /** The plugin's `applied` reply. */
  onApplied(results: readonly CommandResult[]): void {
    for (const r of results) {
      const e = this.entries.get(r.id)
      if (!e) continue
      e.status = r.status
      e.message = r.message
      e.notes = r.notes?.length ? r.notes : undefined
      e.elementIds = r.elementIds
      // skipped: the model already has it (or it has nothing to do); no new version will come for it
      e.landed = r.status === 'skipped'
    }
  }

  /** The plugin's `reverted` reply: the model no longer has these commands. */
  onReverted(results: readonly CommandResult[]): void {
    for (const r of results) {
      const e = this.entries.get(r.id)
      if (e?.status === 'reverting') this.entries.delete(r.id)
    }
  }

  /** A new version of `sheetId` arrived: every command applied on it before now is in that version. */
  onSheetVersion(sheetId: string): void {
    for (const e of this.entries.values()) if (e.sheetId === sheetId && e.status === 'applied') e.landed = true
  }

  /** An `error` answer to an apply or revert: give the commands back to the next plan. */
  onRequestFailed(ids: readonly string[], message: string): void {
    for (const id of ids) {
      const e = this.entries.get(id)
      if (!e) continue
      if (e.status === 'sending') Object.assign(e, { status: 'failed', message, landed: false })
      else if (e.status === 'reverting') e.status = 'applied'
    }
  }

  /**
   * The socket dropped with replies outstanding. A `sending` command may or may not have been applied: forget it so
   * it is sent again (the plugin answers `skipped` if it already has it). A `reverting` one goes back to applied so
   * the revert is sent again.
   */
  onDisconnected(): void {
    for (const e of [...this.entries.values()]) {
      if (e.status === 'sending') this.entries.delete(e.id)
      else if (e.status === 'reverting') e.status = 'applied'
    }
  }

  /** Forget everything about these sheets (closed in the editor). */
  forgetSheets(sheetIds: ReadonlySet<string>): void {
    for (const e of [...this.entries.values()]) if (sheetIds.has(e.sheetId)) this.entries.delete(e.id)
  }

  clear(): void {
    this.entries.clear()
  }

  /** Strokes to hide: every command they made has landed in the model. Strokes without commands stay. */
  landedStrokes(strokes: readonly Stroke[], log: readonly Command[]): Set<string> {
    const byStroke = new Map<string, Command[]>()
    for (const c of log) {
      if (!byStroke.has(c.strokeId)) byStroke.set(c.strokeId, [])
      byStroke.get(c.strokeId)!.push(c)
    }
    const out = new Set<string>()
    for (const s of strokes) {
      const cmds = byStroke.get(s.id)
      if (cmds?.length && cmds.every((c) => this.entries.get(c.id)?.landed)) out.add(s.id)
    }
    return out
  }
}
