import { describe, expect, it } from 'vitest'
import { DrawingFormatError, PT_PER_FT, isGzip, pageLabel, parseDrawingPayload } from '../../../src/core/drawing'
import { BlobBuffer, PNG_BYTES, buildPayload, f32 } from './builder'

const page = (over: Record<string, unknown> = {}) => ({ id: 1, kind: 'sheet', number: 'A1', name: 'Plan', scale: null, min: [0, 0], max: [2, 1], items: [], ...over })

describe('M5-08 .drawing format reader (schema/schema/drawing-format.md)', () => {
  it('converts paper feet (y up) to sheet points (top-left, y down)', () => {
    const b = new BlobBuffer()
    const pts = b.xy(0.5, 1, 1.5, 0.5)
    const segs = b.xy(0, 0, 1, 1)
    const ring = b.xy(0, 0, 1, 0, 1, 1)
    const png = b.add(PNG_BYTES)
    const header = {
      format: 'drawing',
      version: 1,
      source: { file: 'model.rvt', generator: 'g' },
      pages: [
        page({
          min: [0.5, -0.5],
          max: [2.5, 0.5],
          items: [
            { t: 'path', pts, closed: true, w: 0.001, c: [1, 2, 3], dash: [0.01, 0.005], el: 7, view: 9 },
            { t: 'segs', segs, w: 0 },
            { t: 'fill', rings: [ring], c: [200, 200, 200], el: null },
            { t: 'text', text: 'Hi', at: [1, 0], size: 0.01, anchor: 'cm', dir: [0, 1] },
            { t: 'image', min: [1, -0.5], max: [1.5, 0], png },
            { t: 'hologram', what: 1 },
          ],
        }),
      ],
      elements: { '7': { class: 'SWall', category: 'Walls' } },
    }
    const doc = parseDrawingPayload(buildPayload(header, b.bytes()))
    expect(doc.source).toEqual({ file: 'model.rvt', generator: 'g' })
    const p = doc.pages[0]
    expect(p.sizePt).toEqual({ w: 2 * PT_PER_FT, h: 1 * PT_PER_FT })
    expect(p.items.map((i) => i.t)).toEqual(['path', 'segs', 'fill', 'text', 'image']) // unknown type skipped
    const path = p.items[0]
    if (path.t !== 'path') throw new Error()
    // (0.5, 1) -> x 0, y (0.5 - 1) * 864 = -432; (1.5, 0.5) -> x 864, y 0
    expect([...path.xy]).toEqual([0, -432, 864, 0])
    expect(path.w).toBeCloseTo(0.864, 5)
    expect(path.dash[0]).toBeCloseTo(8.64, 4)
    expect(path.el).toBe('7')
    expect(path.view).toBe('9')
    const text = p.items[3]
    if (text.t !== 'text') throw new Error()
    expect(text.at).toEqual({ x: 432, y: 432 })
    expect(text.dir).toEqual({ x: 0, y: -1 }) // up the page in y-up is negative y in sheet space
    expect(text.size).toBeCloseTo(8.64, 4)
    const img = p.items[4]
    if (img.t !== 'image') throw new Error()
    expect(img.rect).toEqual({ x: 432, y: 432, w: 432, h: 432 })
    expect([...img.png]).toEqual([...PNG_BYTES])
  })

  it('lists sheets first, then views, header order within each kind', () => {
    const header = { format: 'drawing', version: 1, pages: [page({ id: 1, kind: 'view', name: '{3D}' }), page({ id: 2 }), page({ id: 3, kind: 'view', name: 'V' }), page({ id: 4 })] }
    const doc = parseDrawingPayload(buildPayload(header, new Uint8Array()))
    expect(doc.pages.map((p) => p.id)).toEqual(['2', '4', '1', '3'])
    expect(pageLabel(doc.pages[0])).toBe('A1 Plan')
    expect(pageLabel(doc.pages[2])).toBe('{3D} (view)')
  })

  it('rejects broken files with a message naming the problem', () => {
    const ok = { format: 'drawing', version: 1, pages: [page()] }
    const err = (bytes: Uint8Array) => {
      try {
        parseDrawingPayload(bytes)
      } catch (e) {
        expect(e).toBeInstanceOf(DrawingFormatError)
        return (e as Error).message
      }
      throw new Error('expected a DrawingFormatError')
    }
    expect(err(buildPayload(ok, new Uint8Array(), { magic: 'DRAWINX\0' }))).toMatch(/bad magic/)
    expect(err(buildPayload(ok, new Uint8Array(), { version: 2 }))).toMatch(/unsupported .drawing version 2/)
    const truncated = buildPayload(ok, new Uint8Array()).subarray(0, 30)
    expect(err(truncated)).toMatch(/runs past the end/)
    expect(err(buildPayload({ ...ok, format: 'nope' }, new Uint8Array()))).toMatch(/header.format/)
    expect(err(buildPayload({ ...ok, pages: [page({ max: [0, 1] })] }, new Uint8Array()))).toMatch(/pages\[0\]\.max/)
    const b = new BlobBuffer()
    const r = b.xy(1, 2)
    expect(err(buildPayload({ ...ok, pages: [page({ items: [{ t: 'path', pts: [r[0], 400], w: 0 }] })] }, b.bytes()))).toMatch(/pages\[0\]\.items\[0\]\.pts: blob .* out of bounds/)
    expect(err(buildPayload({ ...ok, pages: [page({ items: [{ t: 'path', pts: [2, 4], w: 0 }] })] }, new Uint8Array(16)))).toMatch(/not a multiple of 4/)
    expect(err(buildPayload({ ...ok, pages: [page({ items: [{ t: 'segs', segs: [0, 8], w: 0 }] })] }, f32(1, 2, 3, 4)))).toMatch(/items\[0\]\.segs: blob length 8 is not a multiple of 16/)
    expect(err(buildPayload({ ...ok, pages: [page({ items: [{ t: 'path', pts: [0, 8], w: 0 }] })] }, f32(1, NaN)))).toMatch(/items\[0\]\.pts: coordinate 1 is not a finite number/)
  })

  it('sniffs gzip', () => {
    expect(isGzip(new Uint8Array([0x1f, 0x8b, 8]))).toBe(true)
    expect(isGzip(new TextEncoder().encode('{"a":1}'))).toBe(false)
  })
})
