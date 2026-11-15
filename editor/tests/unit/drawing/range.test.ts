import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDrawingUrl, pageAvailable, pageDecoded, watchPages } from '../../../src/app/source/drawing-file'
import { parseDrawingPayload, type DrawingDocument } from '../../../src/core/drawing'
import { buildZstd, i32, pageFrame, type ZstdPage } from './builder'

const blobs = (data: Uint8Array) => ({ refs: [[0, data.byteLength]], buffer: data })
const page = (id: number, x: number): ZstdPage => {
  const b = blobs(i32(0, 0, x, 0, 0, 15240, -x, 0))
  return {
    entry: { id, kind: 'sheet', number: `A${id}`, name: 'Plan', scale: null, min: [0, 0], max: [2, 1] },
    frame: pageFrame({ items: [{ t: 'segs', segs: b.refs[0], w: 0.001, el: id }] }, b.buffer),
  }
}
const file = buildZstd([page(1, 30480), page(2, 15240), page(3, 7620)], { '1': { category: 'Walls' } })
const plain = (doc: DrawingDocument) => JSON.parse(JSON.stringify(doc.pages, (_k, v) => (v instanceof Float32Array ? [...v] : v)))

/** A static host over `bytes`: answers `Range: bytes=a-b` with 206 when `ranges`, else the whole file with 200. */
function serve(bytes: Uint8Array, ranges: boolean) {
  const asked: string[] = []
  vi.stubGlobal('fetch', async (_url: string, init?: { headers?: Record<string, string> }) => {
    const range = init?.headers?.Range
    asked.push(range ?? 'all')
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!ranges || !m) return new Response(bytes.slice(), { status: 200 })
    return new Response(bytes.slice(Number(m[1]), Math.min(Number(m[2]) + 1, bytes.length)), { status: 206 })
  })
  return asked
}

afterEach(() => vi.unstubAllGlobals())

describe('opening a zstd .drawing by URL with range requests', () => {
  it('opens on the first page and the elements, then reads the same pages as the whole file', async () => {
    const asked = serve(file, true)
    const got = await openDrawingUrl('https://host/kro.drawing')
    if (!('doc' in got)) throw new Error('expected a document')
    const doc = got.doc
    // it opens on the first bytes, the first page's frame and the elements table; the other pages are on their way
    expect(asked[0]).toBe('bytes=0-65535')
    expect(doc.pages.map((_, i) => pageAvailable(doc, i))).toEqual([true, false, false])
    expect(doc.pages[0].items).toHaveLength(1)
    expect(doc.elements).toEqual({ '1': { category: 'Walls' } })
    await Promise.all(doc.pages.map((_, i) => pageDecoded(doc, i)))
    expect(doc.pages.map((_, i) => pageAvailable(doc, i))).toEqual([true, true, true])
    expect(plain(doc)).toEqual(plain(parseDrawingPayload(file)))
  })

  it('counts the sheets as they get ready', async () => {
    serve(file, true)
    const got = await openDrawingUrl('https://host/kro.drawing')
    if (!('doc' in got)) throw new Error('expected a document')
    const seen: number[] = []
    watchPages(got.doc, (done, total) => seen.push(done * 10 + total))
    await Promise.all(got.doc.pages.map((_, i) => pageDecoded(got.doc, i)))
    expect(seen[0]).toBeLessThan(33)
    expect(seen.at(-1)).toBe(33)
  })

  it('takes the whole file when the server does not answer ranges', async () => {
    const asked = serve(file, false)
    const got = await openDrawingUrl('https://host/kro.drawing')
    expect(asked).toEqual(['bytes=0-65535'])
    expect('bytes' in got && got.bytes).toEqual(file)
  })

  it('returns the HTTP status of a failed fetch', async () => {
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }))
    expect(await openDrawingUrl('https://host/kro.drawing')).toEqual({ status: 404 })
  })
})
