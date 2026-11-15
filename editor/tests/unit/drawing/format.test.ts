import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseDrawingFile } from '../../../src/app/source/drawing-file'
import { sniffBytes } from '../../../src/app/source'
import { DrawingFormatError, PT_PER_FT, parseDrawingPayload, type DrawingDocument, type DrawingPage } from '../../../src/core/drawing'
import { convertLegacyToZstd } from '../../../scripts/drawing-from-legacy.mjs'
import { BlobBuffer, PNG_BYTES, buildPayload } from './builder-legacy'
import { buildZstd, i32, pageFrame, zstd, type ZstdPage } from './builder'

const near = (a: ArrayLike<number>, b: number[], digits = 3) => {
  expect(a.length).toBe(b.length)
  b.forEach((v, k) => expect(a[k]).toBeCloseTo(v, digits))
}

/** Concatenates blobs, each at a multiple of 4. */
function blobs(...parts: Uint8Array[]) {
  const refs: [number, number][] = []
  const chunks: Uint8Array[] = []
  let size = 0
  for (const p of parts) {
    refs.push([size, p.length])
    const padded = new Uint8Array((p.length + 3) & ~3)
    padded.set(p)
    chunks.push(padded)
    size += padded.length
  }
  const buffer = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    buffer.set(c, at)
    at += c.length
  }
  return { refs, buffer }
}

const entry = (over: Record<string, unknown> = {}) => ({ id: 1, kind: 'sheet', number: 'A1', name: 'Plan', scale: null, min: [0, 0], max: [2, 1], ...over })
const onePage = (json: unknown, buffer: Uint8Array = new Uint8Array(), over: Record<string, unknown> = {}): ZstdPage => ({ entry: entry(over), frame: pageFrame(json, buffer) })

describe('M5-08 .drawing zstd reader (schema/schema/drawing-format.md)', () => {
  it('decodes a tiny page by hand: delta undone, units to sheet points, y flipped', () => {
    // page 0.5..2.5 x -0.5..0.5 ft: 864 pt tall, 1728 pt wide. One unit = 0.01 mm = 864/30480 pt.
    const b = blobs(
      i32(15240, 30480, 15240, -15240), // path: (15240, 30480) then +(15240, -15240) = (30480, 15240)
      i32(0, 0, 30480, 0, 0, 15240, -30480, 0), // segs: (0,0)->(30480,0); start = end + (0,15240) = (30480,15240) -> (0,15240)
      i32(0, 0, 30480, 0, 0, 30480), // ring: (0,0) (30480,0) (30480,30480)
      new Uint8Array(PNG_BYTES),
    )
    const [pts, segs, ring, png] = b.refs
    const page = onePage(
      {
        items: [
          { t: 'path', pts, closed: true, w: 0.001, c: [1, 2, 3], el: 7, view: 9 },
          { t: 'segs', segs, w: 0 },
          { t: 'fill', rings: [ring], c: [200, 200, 200], el: null },
          { t: 'text', text: 'Hi', at: [1, 0], size: 0.01, anchor: 'cm', dir: [0, 1] },
          { t: 'image', min: [1, -0.5], max: [1.5, 0], png },
          { t: 'hologram' },
        ],
        boxes: { '7': [15240, 30480, 30480, 15240] },
      },
      b.buffer,
      { min: [0.5, -0.5], max: [2.5, 0.5] },
    )
    const doc = parseDrawingPayload(buildZstd([page], { '7': { class: 'SWall', category: 'Walls' } }))

    expect(doc.source).toEqual({ file: 'model.rvt', generator: 'test' })
    expect(doc.elements).toEqual({ '7': { class: 'SWall', category: 'Walls' } })
    const p = doc.pages[0]
    expect(p.sizePt).toEqual({ w: 2 * PT_PER_FT, h: PT_PER_FT })
    expect(p.items.map((i) => i.t)).toEqual(['path', 'segs', 'fill', 'text', 'image']) // unknown type skipped
    const [path, segsItem, fill, text, image] = p.items
    if (path.t !== 'path' || segsItem.t !== 'segs' || fill.t !== 'fill' || text.t !== 'text' || image.t !== 'image') throw new Error('item types')
    expect(path.xy).toBeInstanceOf(Float32Array)
    near(path.xy, [432, 0, 864, 432]) // (15240, 30480) -> x 432, y 864 - 864; (30480, 15240) -> x 864, y 864 - 432
    expect(path.closed).toBe(true)
    expect(path.el).toBe('7')
    expect(path.view).toBe('9')
    expect(path.c).toEqual([1, 2, 3])
    near(segsItem.xy, [0, 864, 864, 864, 864, 432, 0, 432])
    near(fill.rings[0], [0, 864, 864, 864, 864, 0])
    expect(text.at.x).toBeCloseTo(432, 6) // text stays JSON paper feet and is converted like the legacy format
    expect(text.at.y).toBeCloseTo(432, 6)
    expect(image.rect).toEqual({ x: 432, y: 432, w: 432, h: 432 })
    expect([...image.png]).toEqual([...PNG_BYTES])
    // box [15240, 30480, 30480, 15240] (y up, from min) -> sheet points [minX, minY, maxX, maxY]
    near(p.boxes!['7'], [432, 0, 864, 432])
  })

  it('decodes viewType and views, with the box in sheet points', () => {
    const page = onePage(
      { items: [], views: { '9': { type: 'section', name: 'Sec A', scale: '1 : 50', box: [15240, 30480, 30480, 15240] }, '10': { type: 'hologram', name: 'X', scale: null } } },
      undefined,
      { kind: 'view', viewType: 'axon' },
    )
    const p = parseDrawingPayload(buildZstd([page], {})).pages[0]
    expect(p.viewType).toBe('axon')
    expect(Object.keys(p.views!)).toEqual(['9', '10'])
    expect(p.views!['9'].type).toBe('section')
    expect(p.views!['9'].name).toBe('Sec A')
    expect(p.views!['9'].scale).toBe('1 : 50')
    near(p.views!['9'].box!, [432, 0, 864, 432])
    expect(p.views!['10']).toEqual({ type: 'other', name: 'X', scale: null }) // unknown type reads as other, no box
  })

  it('an unknown page viewType reads as other', () => {
    const doc = parseDrawingPayload(buildZstd([onePage({ items: [] }, undefined, { viewType: 'hologram' })], {}))
    expect(doc.pages[0].viewType).toBe('other')
  })

  it('a file without viewType and views still decodes', () => {
    const p = parseDrawingPayload(buildZstd([onePage({ items: [] })], {})).pages[0]
    expect(p.viewType).toBeUndefined()
    expect(p.views).toBeUndefined()
  })

  it('rejects bad views, naming the page', () => {
    const msg = (json: unknown, over: Record<string, unknown> = {}) => {
      try {
        parseDrawingPayload(buildZstd([onePage(json, undefined, over)], {}))
      } catch (e) {
        return (e as Error).message
      }
    }
    expect(msg({ items: [], views: { '9': { type: 'plan', name: 'a', scale: null, box: [1, 2, 3] } } })).toMatch(/^pages\[0\]\.views\["9"\]\.box: expected four integers/)
    expect(msg({ items: [], views: [] })).toMatch(/^pages\[0\]\.views: expected an object/)
    expect(msg({ items: [], views: { '9': { type: 5, name: 'a', scale: null } } })).toMatch(/^pages\[0\]\.views\["9"\]\.type: expected a string/)
    expect(msg({ items: [] }, { viewType: 5 })).toMatch(/^pages\[0\]\.viewType: expected a string/)
  })

  it('reads sheets first, the first sheet first, and keeps header order within a kind', () => {
    const view = onePage({ items: [] }, undefined, { id: 1, kind: 'view', name: '{3D}', number: null })
    const doc = parseDrawingPayload(buildZstd([view, onePage({ items: [] }, undefined, { id: 2 }), onePage({ items: [] }, undefined, { id: 3, kind: 'view' }), onePage({ items: [] }, undefined, { id: 4 })], {}))
    expect(doc.pages.map((p) => p.id)).toEqual(['2', '4', '1', '3'])
  })

  it('decodes the same content as the legacy format within 0.005 mm of paper (the converter, level 3 and 19)', () => {
    const b = new BlobBuffer()
    // deterministic scatter over a 3 x 2 ft page whose min is not the origin
    let s = 12345
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648
    const wiggle = (n: number) => Array.from({ length: n }, () => [-1 + 3 * rnd(), -2 + 2 * rnd()]).flat()
    const pts = b.xy(...wiggle(300))
    const segs = b.xy(...wiggle(200)) // 100 segments
    const ringA = b.xy(...wiggle(40))
    const ringB = b.xy(...wiggle(20))
    const png = b.add(PNG_BYTES)
    const header = {
      format: 'drawing',
      version: 1,
      source: { file: 'm.rvt' },
      pages: [
        {
          id: 5,
          kind: 'sheet',
          number: 'A1',
          name: 'P',
          scale: null,
          min: [-1, -2],
          max: [2, 0],
          items: [
            { t: 'path', pts, closed: false, w: 0.001, c: [9, 9, 9], dash: [0.01, 0.02], el: 3, view: 1 },
            { t: 'path', pts, w: 0.002, el: 4 }, // the same blob twice
            { t: 'segs', segs, w: 0.0005, el: 3 },
            { t: 'fill', rings: [ringA, ringB], c: [1, 2, 3], el: 8 },
            { t: 'text', text: 'T', at: [0, -1], size: 0.01, anchor: 'lb', dir: [1, 1], maxWidth: 0.5, bold: true, el: 8 },
            { t: 'image', min: [-0.5, -1.5], max: [0.5, -0.5], png, el: 9 },
          ],
        },
        { id: 6, kind: 'view', number: null, name: '{3D}', scale: '1 : 100', min: [0, 0], max: [1, 1], items: [] },
      ],
      elements: { '3': { class: 'SWall', category: 'Walls', params: [{ name: 'a', value: 'b' }] } },
    }
    const legacyBytes = new Uint8Array(gzipSync(buildPayload(header, b.bytes())))
    return parseDrawingFile(legacyBytes).then(async (legacyDoc) => {
      for (const level of [3, 19]) {
        const zstdDoc = await parseDrawingFile(new Uint8Array(convertLegacyToZstd(legacyBytes, { level })))
        expect(zstdDoc.source).toEqual(legacyDoc.source)
        expect(zstdDoc.elements).toEqual(legacyDoc.elements)
        expect(zstdDoc.pages.map(({ boxes: _boxes, ...rest }) => ({ ...rest, items: rest.items.length }))).toEqual(legacyDoc.pages.map((p) => ({ ...p, items: p.items.length })))
        // f32 slack on top of the half-unit (0.005 mm) rounding of the writer
        expectEqualWithin(legacyDoc, zstdDoc, 0.0051)
      }
    })
  })

  it('the converter writes boxes of each element from its quantised geometry', async () => {
    const b = new BlobBuffer()
    const pts = b.xy(0.5, 0.25, 1.5, 0.75)
    const header = { format: 'drawing', version: 1, pages: [{ id: 1, kind: 'sheet', min: [0, 0], max: [2, 1], items: [{ t: 'path', pts, w: 0.001, el: 7 }, { t: 'path', pts, w: 0.001, el: null }] }], elements: {} }
    const doc = await parseDrawingFile(convertLegacyToZstd(buildPayload(header, b.bytes())))
    expect(Object.keys(doc.pages[0].boxes!)).toEqual(['7']) // items without an element have no box
    near(doc.pages[0].boxes!['7'], [432, 216, 1296, 648])
  })

  it('opens through parseDrawingFile and sniffs as a drawing; the legacy gzip format still opens', async () => {
    const zstdFile = buildZstd([onePage({ items: [] })], {})
    expect(sniffBytes(zstdFile, 'x.drawing')).toBe('drawing')
    expect((await parseDrawingFile(zstdFile)).pages.map((p) => p.id)).toEqual(['1'])
    const legacy = buildPayload({ format: 'drawing', version: 1, pages: [entry({ items: [] })] }, new Uint8Array())
    expect((await parseDrawingFile(new Uint8Array(gzipSync(legacy)))).pages.map((p) => p.id)).toEqual(['1'])
  })

  it('still reads files written while this format was called version 2', async () => {
    const old = buildZstd([onePage({ items: [] })], {}, { version: 2, headerVersion: 2 })
    expect((await parseDrawingFile(old)).pages.map((p) => p.id)).toEqual(['1'])
  })

  describe('reading rules', () => {
    const msg = (bytes: Uint8Array) => {
      try {
        parseDrawingPayload(bytes)
      } catch (e) {
        expect(e).toBeInstanceOf(DrawingFormatError)
        return (e as Error).message
      }
      throw new Error('expected a DrawingFormatError')
    }
    const one = (items: unknown[], buffer: Uint8Array, extra: Record<string, unknown> = {}) => buildZstd([onePage({ items, ...extra }, buffer)], {})

    it('rejects a frame outside the file, naming the page or elements', () => {
      const ok = onePage({ items: [] })
      const second = { ...onePage({ items: [] }, undefined, { id: 2 }), ref: [100000, 10] as [number, number] }
      expect(msg(buildZstd([ok, second], {}))).toMatch(/^pages\[1\]\.frame: \[100000, 10\] is outside the file/)
      expect(msg(buildZstd([ok], {}, { elementsRef: [5, 100000] }))).toMatch(/^elements\.frame: \[5, 100000\] is outside the file/)
    })

    it('rejects a frame that does not decompress, naming the page or elements', () => {
      const junk = new Uint8Array(40).fill(7)
      expect(msg(buildZstd([{ entry: entry(), bytes: junk }], {}))).toMatch(/^pages\[0\]\.frame: does not decompress/)
      expect(msg(buildZstd([onePage({ items: [] })], junk))).toMatch(/^elements\.frame: does not decompress/)
    })

    it('rejects a unitsPerFoot other than 30480', () => {
      expect(msg(buildZstd([onePage({ items: [] })], {}, { unitsPerFoot: 3048 }))).toMatch(/header\.unitsPerFoot: expected 30480, got 3048/)
      expect(msg(buildZstd([onePage({ items: [] })], {}, { unitsPerFoot: null }))).toMatch(/header\.unitsPerFoot/)
    })

    it('rejects a box that is not four integers', () => {
      expect(msg(one([], new Uint8Array(), { boxes: { '12': [1, 2, 3] } }))).toMatch(/^pages\[0\]\.boxes\["12"\]: expected four integers/)
      expect(msg(one([], new Uint8Array(), { boxes: { '12': [1, 2, 3, 4.5] } }))).toMatch(/^pages\[0\]\.boxes\["12"\]/)
      expect(msg(one([], new Uint8Array(), { boxes: { '12': [1, 2, 3, '4'] } }))).toMatch(/^pages\[0\]\.boxes\["12"\]/)
    })

    it('rejects a decoded coordinate that overflows i32', () => {
      const pts = blobs(i32(2147483647, 0, 1, 0)) // x reaches 2^31
      expect(msg(one([{ t: 'path', pts: pts.refs[0], w: 0 }], pts.buffer))).toMatch(/^pages\[0\]\.items\[0\]\.pts: coordinate 2 overflows/)
      const neg = blobs(i32(0, -2147483648, 0, -1))
      expect(msg(one([{ t: 'path', pts: neg.refs[0], w: 0 }], neg.buffer))).toMatch(/pts: coordinate 3 overflows/)
      const segs = blobs(i32(0, 0, 2147483647, 0, 1, 0, 0, 0)) // second segment starts past i32
      expect(msg(one([{ t: 'segs', segs: segs.refs[0], w: 0 }], segs.buffer))).toMatch(/^pages\[0\]\.items\[0\]\.segs: coordinate 4 overflows/)
      const ring = blobs(i32(0, 0, 2147483647, 0, 1, 0))
      expect(msg(one([{ t: 'fill', rings: [ring.refs[0]] }], ring.buffer))).toMatch(/items\[0\]\.rings\[0\]: coordinate 4 overflows/)
    })

    it("applies the legacy format's rules inside the page frame", () => {
      const ok = blobs(i32(1, 2))
      expect(msg(one([{ t: 'path', pts: [ok.refs[0][0], 400], w: 0 }], ok.buffer))).toMatch(/pages\[0\]\.items\[0\]\.pts: blob .* out of bounds/)
      expect(msg(one([{ t: 'path', pts: [2, 4], w: 0 }], new Uint8Array(16)))).toMatch(/not a multiple of 4/)
      expect(msg(one([{ t: 'segs', segs: [0, 8], w: 0 }], i32(1, 2, 3, 4)))).toMatch(/items\[0\]\.segs: blob length 8 is not a multiple of 16/)
      expect(msg(one([{ t: 'path', pts: [0, 4], w: 0 }], i32(1, 2)))).toMatch(/items\[0\]\.pts: blob length 4 is not a multiple of 8/)
      expect(msg(buildZstd([onePage({ items: [] }, undefined, { max: [0, 1] })], {}))).toMatch(/pages\[0\]\.max/)
      expect(msg(buildZstd([{ entry: entry(), frame: new Uint8Array([1, 2]) }], {}))).toMatch(/pages\[0\]\.frame: 2 bytes is shorter/)
      expect(msg(buildZstd([{ entry: entry(), frame: new Uint8Array([200, 0, 0, 0, 0, 0, 0, 0]) }], {}))).toMatch(/pages\[0\]\.frame: page JSON length 200 runs past/)
    })

    it('rejects a bad container', () => {
      const ok = buildZstd([onePage({ items: [] })], {})
      expect(msg(buildZstd([onePage({ items: [] })], {}, { magic: 'DRAWINX\0' }))).toMatch(/bad magic/)
      expect(msg(buildZstd([onePage({ items: [] })], {}, { version: 3 }))).toMatch(/unsupported .drawing version 3/)
      expect(msg(buildZstd([onePage({ items: [] })], {}, { headerVersion: 2 }))).toMatch(/header\.version 2 disagrees/)
      expect(msg(ok.subarray(0, 30))).toMatch(/runs past the end/)
      expect(msg(zstd(new Uint8Array(0)))).toMatch(/not a .drawing file/)
    })
  })
})

/** Every coordinate of two documents' pages agrees within `mm` millimetres of paper. */
function expectEqualWithin(a: DrawingDocument, b: DrawingDocument, mm: number) {
  const tolPt = (mm / 25.4) * 72
  const close = (x: ArrayLike<number>, y: ArrayLike<number>, what: string) => {
    expect(y.length, what).toBe(x.length)
    let worst = 0
    for (let k = 0; k < x.length; k++) worst = Math.max(worst, Math.abs(x[k] - y[k]))
    expect(worst, `${what}: worst error ${worst} pt`).toBeLessThanOrEqual(tolPt)
  }
  a.pages.forEach((pa: DrawingPage, i) => {
    const pb = b.pages[i]
    pa.items.forEach((ia, k) => {
      const ib = pb.items[k]
      const what = `page ${i} item ${k} (${ia.t})`
      expect(ib.t).toBe(ia.t)
      if ((ia.t === 'path' || ia.t === 'segs') && (ib.t === 'path' || ib.t === 'segs')) {
        close(ia.xy, ib.xy, what)
        const { xy: _xa, ...ra } = ia
        const { xy: _xb, ...rb } = ib
        expect(rb).toEqual(ra)
      }
      else if (ia.t === 'fill' && ib.t === 'fill') ia.rings.forEach((r, j) => close(r, ib.rings[j], `${what} ring ${j}`))
      else expect(ib).toEqual(ia)
    })
  })
}

describe('PERF-02 lazy pages: a page frame is decoded when its items are first read', () => {
  const plain = (doc: DrawingDocument) => JSON.parse(JSON.stringify(doc.pages, (_k, v) => (v instanceof Float32Array ? [...v] : v)))
  const segsPage = (id: number, x: number) => {
    const b = blobs(i32(0, 0, x, 0, 0, 15240, -x, 0))
    return onePage({ items: [{ t: 'segs', segs: b.refs[0], w: 0.001, el: id }], boxes: { [id]: [0, 0, x, 15240] } }, b.buffer, { id })
  }
  const file = () => buildZstd([segsPage(1, 30480), segsPage(2, 15240), segsPage(3, 7620)], { '1': { category: 'Walls' } })

  it('reads the same pages, boxes and elements as the eager reader', () => {
    const lazy = parseDrawingPayload(file(), { lazy: true })
    const eager = parseDrawingPayload(file())
    expect(lazy.pages.map((p) => [p.id, p.sizePt])).toEqual(eager.pages.map((p) => [p.id, p.sizePt]))
    expect(plain(lazy)).toEqual(plain(eager))
    expect(lazy.elements).toEqual(eager.elements)
  })

  it('opens a file whose later page is broken, and names that page when its items are read', () => {
    const junk = { entry: entry({ id: 2 }), bytes: new Uint8Array(40).fill(7) }
    const doc = parseDrawingPayload(buildZstd([segsPage(1, 30480), junk], {}), { lazy: true })
    expect(doc.pages[1].id).toBe('2')
    expect(() => doc.pages[1].items).toThrow(/^pages\[1\]\.frame: does not decompress/)
    expect(doc.pages[0].items).toHaveLength(1)
  })

  it('still rejects a broken first page when the file is opened', () => {
    const junk = { entry: entry(), bytes: new Uint8Array(40).fill(7) }
    expect(() => parseDrawingPayload(buildZstd([junk, segsPage(2, 30480)], {}), { lazy: true })).toThrow(/^pages\[0\]\.frame: does not decompress/)
  })
})
