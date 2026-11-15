/**
 * P1-11 in local development: the relay over a folder on disk (scripts/photo-relay-local-store.ts), which the dev
 * server uses when .env.local has no Vercel Blob token.
 */
import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relayWith } from '../../../api/photo-relay'
import { localPhotoStore } from '../../../scripts/photo-relay-local-store'

const SLOT = 'abcdefghijklmnopqrstuv'
const OTHER = 'zyxwvutsrqponmlkjihgfe'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const req = (method: string, query: string, body?: Uint8Array) => new Request(`http://192.168.1.5:5173/api/photo-relay${query}`, { method, body: body as Uint8Array<ArrayBuffer> | undefined })

describe('P1-11 the photo relay over a local folder (dev server)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relay-test-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('P1-11: needs no Blob token; a photo is handed over once with its type, then the file is gone', async () => {
    const relay = relayWith(localPhotoStore(join(dir, 'photos')))
    expect(await (await relay.GET(req('GET', ''))).json()).toEqual({ available: true })
    expect((await relay.GET(req('GET', `?id=${SLOT}`))).status).toBe(204) // folder not made yet: nothing there
    expect((await relay.POST(req('POST', `?id=${SLOT}`, PNG))).status).toBe(204)
    expect(await readdir(join(dir, 'photos'))).toEqual([SLOT])
    const r = await relay.GET(req('GET', `?id=${SLOT}`))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG)
    expect(await readdir(join(dir, 'photos'))).toEqual([])
    expect((await relay.GET(req('GET', `?id=${SLOT}`))).status).toBe(204)
  })

  it('P1-11: DELETE drops a slot; an upload sweeps photos older than an hour; bad slots never touch the disk', async () => {
    const relay = relayWith(localPhotoStore(dir))
    await relay.POST(req('POST', `?id=${SLOT}`, PNG))
    expect((await relay.DELETE(req('DELETE', `?id=${SLOT}`))).status).toBe(204)
    expect(await readdir(dir)).toEqual([])

    await relay.POST(req('POST', `?id=${OTHER}`, PNG))
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(join(dir, OTHER), old, old)
    await relay.POST(req('POST', `?id=${SLOT}`, PNG))
    expect(await readdir(dir)).toEqual([SLOT])

    expect((await relay.POST(req('POST', '?id=../../../../etc/passwd', PNG))).status).toBe(400)
    await expect(localPhotoStore(dir).put('photo-relay/..', PNG, 'image/png')).rejects.toThrow(/invalid/)
    expect(await readdir(dir)).toEqual([SLOT])
  })
})
