/**
 * The live session with Revit (M6). Glue between the RevitLink socket, the command sync, the document store and
 * the stroke session:
 *
 *  - M6-02 open a Revit sheet: `open_sheet`, then the `sheet` reply becomes (part of) the document on screen.
 *  - M6-03 commands committed on a linked sheet go out as `apply` batches, 300 ms after the last commit.
 *  - M6-04 every `sheet` push replaces only that sheet: camera, tool and the other sheets stay. Strokes whose
 *          commands landed are hidden (the sheet draws the real element now). A newer version always wins.
 *  - M6-05 per-command results are kept for the results HUD (failed message, notes).
 *  - M6-06 undo or erase of a stroke whose commands were applied sends `revert`.
 *  - M6-07 `model_changed` pushes (edited in Revit) replace the sheet the same way; strokes not yet sent stay.
 */
import { useSyncExternalStore } from 'react'
import type { Command, Point, Stroke } from '@core/types'
import { getSession, session, subscribeSession } from '../session'
import { getDocState, openLinkedSource, refreshSource, subscribeDoc } from '../store'
import { RevitLink, type LinkSnapshot, type RevitLinkOptions } from './link'
import { sheetLabel, type LinkSheetSummary, type ServerMessage, type SheetMessage } from './protocol'
import { RevitSource } from './source'
import { CommandSync, type SyncEntry } from './sync'
import { elementAnchor } from '../select/selection'

export const APPLY_DEBOUNCE_MS = 300

export interface RevitState {
  link: LinkSnapshot
  /** Sheets the editor asked for and is waiting on. */
  opening: readonly string[]
  /** Sheets on screen from Revit, in board order, with the version shown. */
  open: readonly { id: string; version: number }[]
  /** Commands sent and not answered yet. */
  inFlight: number
  /** The last `applied` said the model had changed under the editor (baseVersion was old). */
  stale: boolean
  /** Last error, for the panel. */
  error?: string
  /** Bumped whenever command results change (the HUD re-reads `entryFor`). */
  resultsRev: number
  /** Notes the user dismissed (command id). */
  dismissed: ReadonlySet<string>
}

type Pending =
  | { kind: 'apply' | 'revert'; sheetId: string; ids: string[] }
  | { kind: 'open'; sheetId: string }
  | { kind: 'show'; sheetId: string }

let link: RevitLink | null = null
let linkOpts: RevitLinkOptions = {}
let unsubLink: Array<() => void> = []
const sync = new CommandSync()
let current: RevitSource | null = null
/** Epoch of the server the open sheets came from. */
let epoch: string | null = null
const pending = new Map<string, Pending>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** Sheet messages are applied one at a time, in arrival order. */
let sheetQueue: Promise<void> = Promise.resolve()

let state: RevitState = {
  link: { state: 'off', welcome: null, document: null, sheets: [], attempt: 0 },
  opening: [],
  open: [],
  inFlight: 0,
  stale: false,
  resultsRev: 0,
  dismissed: new Set(),
}
const listeners = new Set<() => void>()
function set(next: Partial<RevitState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const getRevit = (): RevitState => state
export const useRevit = (): RevitState => useSyncExternalStore(subscribe, getRevit)
export const entryFor = (commandId: string): SyncEntry | undefined => sync.entry(commandId)
/** The Revit source on screen, if the document is one. */
export const linkedSource = (): RevitSource | null => current

/** Tests: use a fake socket / other URL. Call before the first connect. */
export function configureRevitLink(opts: RevitLinkOptions) {
  linkOpts = opts
  if (link) {
    link.disconnect()
    unsubLink.forEach((u) => u())
    unsubLink = []
    link = null
  }
}

function ensureLink(): RevitLink {
  if (link) return link
  const l = new RevitLink(linkOpts)
  link = l
  unsubLink = [
    l.onChange(() => onLinkChange(l)),
    l.onMessage((m) => onMessage(m)),
  ]
  installWatchers()
  return l
}

// ─────────────── public actions ───────────────

export const revit = {
  connect() {
    ensureLink().connect()
  },
  disconnect() {
    link?.disconnect()
  },
  retry() {
    ensureLink().retry()
  },
  /** M6-02: open a Revit sheet next to the ones already open from the same model (or as a new document). */
  openSheet(sheetId: string) {
    revit.openSheets([sheetId])
  },
  /**
   * M6-10: open several Revit sheets in one go. One `open_sheet` each, in this order (Revit answers them one at a
   * time, so they land on the board in this order); only the first is brought up in Revit.
   */
  openSheets(sheetIds: readonly string[]) {
    const l = ensureLink()
    const ids = [...new Set(sheetIds)]
    const fresh = ids.filter((id) => !state.opening.includes(id) && !current?.has(id))
    if (!fresh.length) return ids.length ? revit.showSheet(ids[0]) : undefined
    const sent: string[] = []
    for (const sheetId of fresh) {
      const requestId = l.send({ type: 'open_sheet', sheetId })
      if (!requestId) break
      pending.set(requestId, { kind: 'open', sheetId })
      sent.push(sheetId)
    }
    if (!sent.length) return set({ error: 'Not connected to Revit.' })
    set({ opening: [...state.opening, ...sent], error: undefined })
    revit.showSheet(sent[0])
  },
  /** Make the sheet the active view in Revit, so Revit follows what the user opened in the editor. */
  showSheet(sheetId: string) {
    const requestId = link?.send({ type: 'show_sheet', sheetId })
    if (requestId) pending.set(requestId, { kind: 'show', sheetId })
  },
  /** Stop showing one Revit sheet. Closing the last one leaves the document empty of sheets, so it is kept. */
  async closeSheet(sheetId: string) {
    const src = current
    if (!src?.has(sheetId) || src.sheetIds().length <= 1) return
    link?.send({ type: 'close_sheet', sheetId })
    sync.forgetSheets(new Set([sheetId]))
    src.removeSheet(sheetId)
    await refreshSource(src, [])
    publishOpen()
  },
  dismissNote(commandId: string) {
    set({ dismissed: new Set(state.dismissed).add(commandId) })
  },
  clearError() {
    set({ error: undefined, stale: false })
  },
  /** Send pending commands now instead of after the debounce (tests, and the panel's "Send now"). */
  flush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    flushSync()
  },
}

// ─────────────── link events ───────────────

let lastLinkState: LinkSnapshot['state'] = 'off'

function onLinkChange(l: RevitLink) {
  const snap = l.snapshot
  const was = lastLinkState
  lastLinkState = snap.state
  if (was === 'on' && snap.state !== 'on') {
    // replies to what was in flight will not come
    sync.onDisconnected()
    pending.clear()
    set({ opening: [], inFlight: 0, resultsRev: state.resultsRev + 1 })
  }
  set({ link: snap })
}

function onMessage(m: ServerMessage) {
  switch (m.type) {
    case 'welcome': {
      if (current) {
        if (epoch !== m.server.epoch) {
          // the plugin restarted: its versions start again from 1
          current.resetVersions()
          epoch = m.server.epoch
        }
        // re-subscribe every sheet on screen; the replies replace them if the model moved on
        for (const id of current.sheetIds()) {
          const requestId = link?.send({ type: 'open_sheet', sheetId: id })
          if (requestId) pending.set(requestId, { kind: 'open', sheetId: id })
        }
      }
      scheduleSync(0)
      break
    }
    case 'sheet':
      sheetQueue = sheetQueue.then(() => onSheet(m)).catch((e) => set({ error: `Could not show the sheet from Revit: ${(e as Error).message}` }))
      break
    case 'applied': {
      if (m.requestId) pending.delete(m.requestId)
      sync.onApplied(m.results)
      afterResults({ stale: state.stale || m.stale })
      break
    }
    case 'reverted': {
      if (m.requestId) pending.delete(m.requestId)
      sync.onReverted(m.results)
      afterResults({})
      scheduleSync() // a redo during the revert is planned now
      break
    }
    case 'shown':
      if (m.requestId) pending.delete(m.requestId)
      break
    case 'error': {
      const p = m.requestId ? pending.get(m.requestId) : undefined
      if (m.requestId) pending.delete(m.requestId)
      // a plugin older than show_sheet does not know it; the sheet still opens in the editor
      if (p?.kind === 'show' && m.code === 'unknown_type') break
      if (p?.kind === 'open') set({ opening: state.opening.filter((id) => id !== p.sheetId) })
      else if (p && p.kind !== 'show') sync.onRequestFailed(p.ids, m.message)
      afterResults({ error: `Revit: ${m.message}` })
      break
    }
  }
}

async function onSheet(m: SheetMessage) {
  if (m.requestId) pending.delete(m.requestId)
  const wanted = state.opening.includes(m.sheetId) || current?.has(m.sheetId)
  if (!wanted) return
  const summary = state.link.sheets.find((s) => s.id === m.sheetId)
  const doc = getDocState()
  if (!current || doc.source !== current) {
    // first sheet: a new document
    const welcome = state.link.welcome
    const src = new RevitSource(`${welcome?.document.title ?? 'Revit'} (Revit)`, welcome?.server.epoch ?? '')
    await src.setSheet(m.sheetId, m.version, m.package, summary)
    current = src
    epoch = src.epoch
    sync.clear()
    await openLinkedSource(src)
  } else {
    const added = !current.has(m.sheetId)
    const changed = await current.setSheet(m.sheetId, m.version, m.package, summary)
    if (changed || added) await refreshSource(current, [m.sheetId])
  }
  set({ opening: state.opening.filter((id) => id !== m.sheetId) })
  sync.onSheetVersion(m.sheetId)
  publishOpen()
  afterResults({})
}

function publishOpen() {
  const src = current
  set({ open: src ? src.sheetIds().map((id) => ({ id, version: src.versionOf(id) })) : [] })
}

function afterResults(extra: Partial<RevitState>) {
  updateHidden()
  set({ ...extra, inFlight: countInFlight(), resultsRev: state.resultsRev + 1 })
}

const countInFlight = () => sync.all().filter((e) => e.status === 'sending' || e.status === 'reverting').length

function updateHidden() {
  const st = getSession()
  if (!current || getDocState().source !== current) return
  session.setHidden(sync.landedStrokes(st.strokes, st.commands))
}

// ─────────────── sync ───────────────

function scheduleSync(ms = APPLY_DEBOUNCE_MS) {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSync()
  }, ms)
}

function flushSync() {
  const src = current
  if (!link || link.state !== 'on' || !src || getDocState().source !== src) return
  const linked = new Set(src.sheetIds())
  const plan = sync.plan(getSession().commands, linked)
  for (const b of plan.apply) {
    const requestId = link.send({ type: 'apply', sheetId: b.sheetId, baseVersion: src.versionOf(b.sheetId), commands: b.commands })
    if (requestId) pending.set(requestId, { kind: 'apply', sheetId: b.sheetId, ids: b.commands.map((c) => c.id) })
  }
  for (const b of plan.revert) {
    const requestId = link.send({ type: 'revert', sheetId: b.sheetId, commandIds: b.commandIds })
    if (requestId) pending.set(requestId, { kind: 'revert', sheetId: b.sheetId, ids: b.commandIds })
  }
  if (plan.apply.length || plan.revert.length) afterResults({})
}

// ─────────────── watchers ───────────────

let watching = false
function installWatchers() {
  if (watching) return
  watching = true
  let lastCommands = getSession().commands
  let lastStrokes = getSession().strokes
  subscribeSession(() => {
    const st = getSession()
    if (st.commands === lastCommands && st.strokes === lastStrokes) return
    const commandsChanged = st.commands !== lastCommands
    lastCommands = st.commands
    lastStrokes = st.strokes
    if (!current || getDocState().source !== current) return
    updateHidden()
    if (commandsChanged && sync.hasWork(st.commands, new Set(current.sheetIds()))) scheduleSync()
  })
  subscribeDoc(() => {
    // another file was opened: the Revit sheets are gone from the screen
    const src = current
    const doc = getDocState()
    // a file opened while a Revit sheet was on its way: that file wins over the late reply
    if (doc.status === 'ready' && doc.source !== src && state.opening.length) set({ opening: [] })
    if (src && doc.source !== src && doc.status !== 'loading') {
      for (const id of src.sheetIds()) link?.send({ type: 'close_sheet', sheetId: id })
      current = null
      epoch = null
      sync.clear()
      set({ open: [], opening: [], stale: false, resultsRev: state.resultsRev + 1 })
    }
  })
}

// ─────────────── helpers for the UI ───────────────

/** Where to pin a command's result on its sheet. */
export function anchorOf(cmd: Command, strokes: readonly Stroke[]): Point | null {
  switch (cmd.op) {
    case 'create_wall': {
      const pts = cmd.path.points
      return pts.length ? pts[pts.length - 1] : null
    }
    case 'place_door':
    case 'place_instance':
      return cmd.at
    case 'delete': {
      const s = strokes.find((x) => x.id === cmd.strokeId)
      const p = s?.points[s.points.length - 1]
      return p ? { x: p.x, y: p.y } : null
    }
    case 'set_type':
      return elementAnchor(cmd.sheetId, cmd.targets[0])
  }
}

export const linkSheetLabel = (s: LinkSheetSummary) => sheetLabel(s)

/** Test API (M6): what the link holds, as data. */
export function revitSnapshot() {
  return {
    state: state.link.state,
    detail: state.link.detail,
    document: state.link.document,
    sheets: state.link.sheets.slice(),
    open: state.open.slice(),
    opening: state.opening.slice(),
    inFlight: state.inFlight,
    stale: state.stale,
    error: state.error,
    results: sync.all().map((e) => ({ ...e })),
    hidden: [...getSession().hidden],
  }
}
