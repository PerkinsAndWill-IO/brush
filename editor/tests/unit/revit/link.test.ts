import { describe, expect, it } from 'vitest'
import { RevitLink, type SocketLike } from '../../../src/app/revit/link'
import { healthUrlFor, parseServerMessage } from '../../../src/app/revit/protocol'

class FakeSocket implements SocketLike {
  sent: unknown[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d))
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.({})
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  drop() {
    this.onclose?.({})
  }
}

function harness(opts: { reachable?: boolean } = {}) {
  const sockets: FakeSocket[] = []
  const timers: { fn: () => void; ms: number; live: boolean }[] = []
  const link = new RevitLink({
    url: 'ws://127.0.0.1:47821/link',
    createSocket: (u) => {
      const s = new FakeSocket(u)
      sockets.push(s)
      return s
    },
    probe: async () => opts.reachable ?? false,
    backoffMs: [100, 200, 400],
    timers: {
      set: (fn, ms) => {
        const t = { fn, ms, live: true }
        timers.push(t)
        return t
      },
      clear: (h) => void ((h as { live: boolean }).live = false),
    },
  })
  const fire = () => {
    const t = timers.filter((x) => x.live).pop()
    if (!t) throw new Error('no timer')
    t.live = false
    t.fn()
  }
  return { link, sockets, timers, fire }
}

const welcome = {
  type: 'welcome',
  protocol: 1,
  server: { name: 'brush-revit-link', version: '0.1.0', host: 'DevHost', epoch: 'e1' },
  document: { title: 'Tower A' },
  sheets: [{ id: '382617', number: 'A102', name: 'Plans' }],
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('M6-01 RevitLink', () => {
  it('connects, sends hello first, and is on after the welcome with its sheets', () => {
    const { link, sockets } = harness()
    const states: string[] = []
    link.onChange(() => states.push(link.state))
    link.connect()
    expect(link.state).toBe('connecting')
    expect(sockets[0].url).toBe('ws://127.0.0.1:47821/link')
    sockets[0].open()
    expect(sockets[0].sent[0]).toMatchObject({ type: 'hello', protocol: 1 })
    expect(link.send({ type: 'ping' })).toBeNull() // not welcomed yet
    sockets[0].receive(welcome)
    expect(link.state).toBe('on')
    expect(link.snapshot.sheets).toEqual(welcome.sheets)
    expect(link.snapshot.document?.title).toBe('Tower A')
    expect(states).toContain('on')
  })

  it('sends messages with a requestId once on, and passes replies to listeners', () => {
    const { link, sockets } = harness()
    const got: string[] = []
    link.onMessage((m) => got.push(m.type))
    link.connect()
    sockets[0].open()
    sockets[0].receive(welcome)
    const id = link.send({ type: 'open_sheet', sheetId: '382617' })
    expect(id).toMatch(/^r\d+$/)
    expect(sockets[0].sent[1]).toEqual({ type: 'open_sheet', sheetId: '382617', requestId: id })
    sockets[0].receive({ type: 'pong', requestId: id })
    sockets[0].receive({ type: 'nonsense' })
    expect(got).toEqual(['welcome', 'pong'])
  })

  it('updates the sheet list on a pushed sheets message', () => {
    const { link, sockets } = harness()
    link.connect()
    sockets[0].open()
    sockets[0].receive(welcome)
    sockets[0].receive({ type: 'sheets', document: { title: 'Tower B' }, sheets: [] })
    expect(link.snapshot.sheets).toEqual([])
    expect(link.snapshot.document?.title).toBe('Tower B')
  })

  it('reconnects with backoff after a drop, and resets the backoff on welcome', async () => {
    const { link, sockets, timers, fire } = harness()
    link.connect()
    sockets[0].open()
    sockets[0].receive(welcome)
    sockets[0].drop()
    expect(link.state).toBe('connecting')
    expect(timers.at(-1)!.ms).toBe(100)
    fire()
    expect(sockets).toHaveLength(2)
    sockets[1].drop() // never opened, nothing on the health URL
    await flush()
    expect(timers.at(-1)!.ms).toBe(200)
    fire()
    sockets[2].drop()
    await flush()
    fire()
    sockets[3].drop()
    await flush()
    expect(timers.at(-1)!.ms).toBe(400) // the last value repeats
    fire()
    sockets[4].open()
    sockets[4].receive(welcome)
    expect(link.state).toBe('on')
    expect(link.snapshot.attempt).toBe(0)
  })

  it('is refused (and stops retrying) when the socket fails but Revit answers on the health URL', async () => {
    const { link, sockets, timers } = harness({ reachable: true })
    link.connect()
    sockets[0].drop()
    await flush()
    expect(link.state).toBe('refused')
    expect(link.snapshot.detail).toMatch(/allow/i)
    expect(timers.filter((t) => t.live)).toHaveLength(0)
    link.retry()
    expect(link.state).toBe('connecting')
    expect(sockets).toHaveLength(2)
  })

  it('is refused on protocol_mismatch', () => {
    const { link, sockets } = harness()
    link.connect()
    sockets[0].open()
    sockets[0].receive({ type: 'error', code: 'protocol_mismatch', message: 'plugin speaks protocol 2, editor sent 1' })
    sockets[0].drop()
    expect(link.state).toBe('refused')
    expect(link.snapshot.detail).toMatch(/protocol/)
  })

  it('goes off on disconnect and does not reconnect', () => {
    const { link, sockets, timers } = harness()
    link.connect()
    sockets[0].open()
    sockets[0].receive(welcome)
    link.disconnect()
    expect(sockets[0].closed).toBe(true)
    sockets[0].drop()
    expect(link.state).toBe('off')
    expect(timers.filter((t) => t.live)).toHaveLength(0)
  })

  it('parses only known server messages and derives the health URL', () => {
    expect(parseServerMessage('{"type":"pong"}')).toEqual({ type: 'pong' })
    expect(parseServerMessage('{"type":"hello"}')).toBeNull()
    expect(parseServerMessage('not json')).toBeNull()
    expect(healthUrlFor('ws://127.0.0.1:47821/link')).toBe('http://127.0.0.1:47821/health')
  })
})
