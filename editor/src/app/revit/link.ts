/**
 * RevitLink (M6-01): the WebSocket client of the Brush Link add-in.
 *
 * - Connects to `ws://127.0.0.1:47821/link`, sends `hello`, and holds the `welcome` (document + sheet list).
 * - Reconnects with backoff while the user wants the link on.
 * - State: `off` (not wanted), `connecting` (opening, or waiting to retry), `on` (welcomed), `refused` (Revit is
 *   there but said no: origin not allowed, or protocol mismatch). A refused link does not retry by itself.
 *
 * The socket, the health probe and the timers are injectable so the unit tests drive it with fakes.
 * No DOM beyond the browser WebSocket and fetch defaults.
 */
import {
  DEFAULT_LINK_URL,
  LINK_PROTOCOL,
  healthUrlFor,
  parseServerMessage,
  type ClientMessage,
  type LinkDocument,
  type LinkSheetSummary,
  type ServerMessage,
  type WelcomeMessage,
} from './protocol'

export type LinkState = 'off' | 'connecting' | 'on' | 'refused'

/** The part of the browser WebSocket the link uses. */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export type SocketFactory = (url: string) => SocketLike

export interface LinkTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface RevitLinkOptions {
  url?: string
  createSocket?: SocketFactory
  /** True when something answers on the health URL (used to tell "refused" from "not running"). */
  probe?: (healthUrl: string) => Promise<boolean>
  /** Delay before each retry; the last value repeats. */
  backoffMs?: readonly number[]
  timers?: LinkTimers
  client?: string
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 4000, 8000]

const defaultTimers: LinkTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

async function defaultProbe(url: string): Promise<boolean> {
  try {
    // The health endpoint sends no CORS headers: an opaque answer still proves the server is there.
    await fetch(url, { mode: 'no-cors', cache: 'no-store' })
    return true
  } catch {
    return false
  }
}

export interface LinkSnapshot {
  state: LinkState
  /** Why the link is refused or retrying, for the UI. */
  detail?: string
  welcome: WelcomeMessage | null
  document: LinkDocument | null
  sheets: readonly LinkSheetSummary[]
  /** Retries since the last welcome. */
  attempt: number
}

export class RevitLink {
  readonly url: string
  private readonly createSocket: SocketFactory
  private readonly probe: (u: string) => Promise<boolean>
  private readonly backoff: readonly number[]
  private readonly timers: LinkTimers
  private readonly client: string
  private ws: SocketLike | null = null
  private retryTimer: unknown = null
  private wanted = false
  private seq = 0
  private refusal: string | undefined
  private snap: LinkSnapshot = { state: 'off', welcome: null, document: null, sheets: [], attempt: 0 }
  private readonly messageListeners = new Set<(m: ServerMessage) => void>()
  private readonly changeListeners = new Set<() => void>()

  constructor(opts: RevitLinkOptions = {}) {
    this.url = opts.url ?? DEFAULT_LINK_URL
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike)
    this.probe = opts.probe ?? defaultProbe
    this.backoff = opts.backoffMs?.length ? opts.backoffMs : DEFAULT_BACKOFF_MS
    this.timers = opts.timers ?? defaultTimers
    this.client = opts.client ?? 'brush-editor'
  }

  get snapshot(): LinkSnapshot {
    return this.snap
  }
  get state(): LinkState {
    return this.snap.state
  }

  /** Turn the link on: connect now and keep reconnecting until `disconnect`. */
  connect(): void {
    this.wanted = true
    if (this.ws || this.retryTimer !== null) return
    this.refusal = undefined
    this.open()
  }

  /** Try again now (after a refusal, or to skip the backoff wait). */
  retry(): void {
    this.wanted = true
    this.clearRetry()
    if (this.ws) return
    this.refusal = undefined
    this.update({ attempt: 0 })
    this.open()
  }

  disconnect(): void {
    this.wanted = false
    this.clearRetry()
    const ws = this.ws
    this.ws = null
    ws?.close(1000, 'editor disconnected')
    this.update({ state: 'off', detail: undefined, welcome: null, attempt: 0 })
  }

  /** True when something answers on the health URL: Revit with the add-in (or the DevHost) is running. */
  reachable(): Promise<boolean> {
    return this.probe(healthUrlFor(this.url))
  }

  /** Send a message when the link is on. Returns its requestId, or null when not connected. */
  send(msg: ClientMessage): string | null {
    if (!this.ws || this.snap.state !== 'on') return null
    const requestId = msg.requestId ?? `r${++this.seq}`
    this.ws.send(JSON.stringify({ ...msg, requestId }))
    return requestId
  }

  onMessage(l: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(l)
    return () => this.messageListeners.delete(l)
  }

  onChange(l: () => void): () => void {
    this.changeListeners.add(l)
    return () => this.changeListeners.delete(l)
  }

  // ─────────────── internals ───────────────

  private update(next: Partial<LinkSnapshot>) {
    this.snap = { ...this.snap, ...next }
    this.changeListeners.forEach((l) => l())
  }

  private clearRetry() {
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer)
    this.retryTimer = null
  }

  private open() {
    this.update({ state: 'connecting' })
    let opened = false
    let ws: SocketLike
    try {
      ws = this.createSocket(this.url)
    } catch (e) {
      // e.g. the page's CSP or mixed-content rules forbid the URL: retrying will not help
      this.update({ state: 'refused', detail: `The browser would not open ${this.url}: ${(e as Error).message}` })
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      opened = true
      ws.send(JSON.stringify({ type: 'hello', protocol: LINK_PROTOCOL, client: this.client, requestId: `r${++this.seq}` }))
    }
    ws.onerror = () => {}
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return
      const msg = parseServerMessage(ev.data)
      if (!msg) return
      if (msg.type === 'welcome') {
        this.update({ state: 'on', detail: undefined, welcome: msg, document: msg.document, sheets: msg.sheets, attempt: 0 })
      } else if (msg.type === 'sheets') {
        this.update({ document: msg.document, sheets: msg.sheets })
      } else if (msg.type === 'error' && msg.code === 'protocol_mismatch') {
        this.refusal = `Revit speaks another protocol version: ${msg.message}. Update the Brush Link add-in or the editor.`
      }
      this.messageListeners.forEach((l) => l(msg))
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      const wasOn = this.snap.state === 'on'
      this.update({ welcome: null })
      if (!this.wanted) return this.update({ state: 'off' })
      if (this.refusal) return this.update({ state: 'refused', detail: this.refusal })
      if (opened || wasOn) return this.scheduleRetry('The connection to Revit dropped. Reconnecting…')
      // Never opened: Revit is not running, or it is and it turned this page away (HTTP 403).
      void this.probe(healthUrlFor(this.url)).then((reachable) => {
        if (!this.wanted || this.ws || this.retryTimer !== null) return
        if (reachable)
          this.update({
            state: 'refused',
            detail: 'Revit is running but did not let this page connect. Allow it in the Brush Link dialog in Revit, or add this address to allowedOrigins, then try again.',
          })
        else this.scheduleRetry('Waiting for Revit. Open a model with the Brush Link add-in.')
      })
    }
  }

  private scheduleRetry(detail: string) {
    const attempt = this.snap.attempt
    const ms = this.backoff[Math.min(attempt, this.backoff.length - 1)]
    this.update({ state: 'connecting', detail, attempt: attempt + 1 })
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null
      if (this.wanted && !this.ws) this.open()
    }, ms)
  }
}
