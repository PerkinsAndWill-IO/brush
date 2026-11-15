/**
 * P1-11: a photo sent from a phone to the import dialog. api/photo-relay.ts (with Vercel Blob replaced by an
 * in-memory store) and the client side in src/app/photo/phoneRelay.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, { bytes: Uint8Array; contentType: string; uploadedAt: Date }>()
vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (path: string, body: Blob, opts: { access: string; contentType: string }) => {
    expect(opts.access).toBe('private') // never a public link
    store.set(path, { bytes: new Uint8Array(await body.arrayBuffer()), contentType: opts.contentType, uploadedAt: new Date() })
    return { pathname: path }
  }),
  get: vi.fn(async (path: string) => {
    const b = store.get(path)
    return b ? { statusCode: 200, stream: new Blob([b.bytes as Uint8Array<ArrayBuffer>]).stream(), blob: { contentType: b.contentType } } : null
  }),
  del: vi.fn(async (paths: string | string[]) => {
    for (const p of Array.isArray(paths) ? paths : [paths]) store.delete(p)
  }),
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({ blobs: [...store.entries()].filter(([p]) => p.startsWith(prefix)).map(([pathname, b]) => ({ pathname, uploadedAt: b.uploadedAt })) })),
}))

const relay = await import('../../../api/photo-relay')
const client = await import('../../../src/app/photo/phoneRelay')

const SLOT = 'abcdefghijklmnopqrstuv'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 2, 3])
const req = (method: string, query: string, body?: Uint8Array) => new Request(`https://brush.example/api/photo-relay${query}`, { method, body: body as Uint8Array<ArrayBuffer> | undefined })

describe('P1-11 the photo relay (server)', () => {
  beforeEach(() => {
    store.clear()
    process.env.BLOB_READ_WRITE_TOKEN = 'test'
  })
  afterEach(() => {
    delete process.env.BLOB_READ_WRITE_TOKEN
  })

  it('P1-11: a photo posted to a slot is handed over once, then it is gone', async () => {
    expect((await relay.GET(req('GET', `?id=${SLOT}`))).status).toBe(204) // nothing yet
    expect((await relay.POST(req('POST', `?id=${SLOT}`, JPEG))).status).toBe(204)
    const r = await relay.GET(req('GET', `?id=${SLOT}`))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(JPEG)
    expect(store.size).toBe(0)
    expect((await relay.GET(req('GET', `?id=${SLOT}`))).status).toBe(204)
  })

  it('P1-11: refuses bad slots, non-images and oversized photos; DELETE drops a slot', async () => {
    expect((await relay.POST(req('POST', '?id=../../etc', JPEG))).status).toBe(400)
    expect((await relay.POST(req('POST', `?id=${SLOT}`, new TextEncoder().encode('<html>hello</html>')))).status).toBe(415)
    const big = new Uint8Array(relay.MAX_PHOTO_BYTES + 1)
    big.set(JPEG)
    expect((await relay.POST(req('POST', `?id=${SLOT}`, big))).status).toBe(413)
    expect(store.size).toBe(0)
    await relay.POST(req('POST', `?id=${SLOT}`, JPEG))
    expect((await relay.DELETE(req('DELETE', `?id=${SLOT}`))).status).toBe(204)
    expect(store.size).toBe(0)
  })

  it('P1-11: says when no Blob store is connected', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN
    expect(await (await relay.GET(req('GET', ''))).json()).toEqual({ available: false })
    expect((await relay.POST(req('POST', `?id=${SLOT}`, JPEG))).status).toBe(503)
    process.env.BLOB_READ_WRITE_TOKEN = 'test'
    expect(await (await relay.GET(req('GET', ''))).json()).toEqual({ available: true })
  })

  it('P1-11: knows JPEG, PNG and HEIC by their first bytes, the same way as the phone page', async () => {
    const { imageType: pageImageType } = await import('../../../src/app/photo/imageType')
    const cases: [Uint8Array, string | null][] = [
      [JPEG, 'image/jpeg'],
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), 'image/png'],
      [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99]), 'image/heic'],
      [new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 105, 102, 49]), 'image/heic'], // mif1
      [new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), null], // GIF
      [new Uint8Array([0xff, 0xd8]), null],
    ]
    for (const [bytes, type] of cases) {
      expect(relay.imageType(bytes)).toBe(type)
      expect(pageImageType(bytes)).toBe(type)
    }
  })

  it('P1-11: function files import only packages (Vercel runs them as plain ES modules)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = new URL('../../../api/', import.meta.url)
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const source = readFileSync(new URL(name, dir), 'utf8')
      expect([...source.matchAll(/^\s*(?:import|export)\b[^'"\n]*from\s+['"](\.[^'"]*)['"]/gm)].map((m) => m[1]), name).toEqual([])
    }
  })
})

describe('P1-11 the photo relay (dialog side)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('P1-11: slot ids are 128 random bits, link and local-address checks', () => {
    const a = client.newSlotId()
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(client.newSlotId()).not.toBe(a)
    expect(client.phoneLink('https://brush-editor.vercel.app', a)).toBe(`https://brush-editor.vercel.app/?phone=${a}`)
    expect(client.isLocalOrigin('localhost')).toBe(true)
    expect(client.isLocalOrigin('127.0.0.1')).toBe(true)
    expect(client.isLocalOrigin('brush-editor.vercel.app')).toBe(false)
  })

  it('P1-11: the dialog waits until the photo is there and gets it as a file', async () => {
    const replies = [new Response(null, { status: 204 }), new Response(null, { status: 204 }), new Response(new Blob([JPEG]), { status: 200, headers: { 'content-type': 'image/jpeg' } })]
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (calls.push(url), replies.shift()!)))
    vi.useFakeTimers()
    const p = client.waitForPhoto(SLOT, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(client.POLL_MS * 3)
    const file = await p
    vi.useRealTimers()
    expect(calls).toHaveLength(3)
    expect(calls[0]).toBe(`/api/photo-relay?id=${SLOT}`)
    expect(file.name).toBe('phone-photo.jpg')
    expect(file.type).toBe('image/jpeg')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(JPEG)
  })

  it('P1-11: the code expires, and a deployment without storage says so', async () => {
    let t = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    vi.useFakeTimers()
    const p = client.waitForPhoto(SLOT, new AbortController().signal, () => (t += client.SLOT_LIFETIME_MS / 2))
    const done = expect(p).rejects.toThrow(/expired/)
    await vi.advanceTimersByTimeAsync(client.POLL_MS * 3)
    await done
    vi.useRealTimers()

    vi.stubGlobal('fetch', vi.fn(async () => new Response('Phone upload is not set up on this deployment', { status: 503 })))
    await expect(client.waitForPhoto(SLOT, new AbortController().signal)).rejects.toThrow(/not set up/)
  })
})
