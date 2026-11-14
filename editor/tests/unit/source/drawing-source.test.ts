import { describe, expect, it } from 'vitest'
import { DrawingFileSource, SourceError, openSource, parseDrawingFile, sniffBytes } from '../../../src/app/source'
import { BlobBuffer, buildDrawing, buildPayload } from '../drawing/builder-legacy'

function tiny() {
  const b = new BlobBuffer()
  const pts = b.xy(0.2, 0.5, 1.2, 0.5, 1.2, 0.51, 0.2, 0.51)
  const header = {
    format: 'drawing',
    version: 1,
    source: { file: 'tower.rvt' },
    pages: [
      { id: 7, kind: 'view', name: '{3D}', scale: '1 : 50', min: [0, 0], max: [1, 1], items: [] },
      { id: 5, kind: 'sheet', number: 'A-101', name: 'Plan', min: [0, 0], max: [2, 1], items: [{ t: 'path', pts, closed: true, w: 0.001, el: 1, view: 3 }] },
    ],
    elements: { '1': { category: 'Walls', type: 'Generic - 300mm' } },
  }
  return { gz: buildDrawing(header, b.bytes()), raw: buildPayload(header, b.bytes()) }
}

describe('M5-08 DrawingSource for binary .drawing files (decision 0008)', () => {
  it('sniffs gzip and raw payloads as drawing, not as a manifest package', () => {
    const { gz, raw } = tiny()
    expect(sniffBytes(gz, 'x.drawing')).toBe('drawing')
    expect(sniffBytes(raw)).toBe('drawing')
    expect(sniffBytes(new TextEncoder().encode('{"schemaVersion":1}'), 'x.drawing')).toBe('package-json')
  })

  it('opens through openSource: sheets in viewer order, package context, project from the source file', async () => {
    const src = await openSource({ name: 'tower.drawing', bytes: tiny().gz })
    expect(src).toBeInstanceOf(DrawingFileSource)
    expect(src.kind).toBe('package')
    expect(src.project).toBe('tower')
    const { sheets, pdf, pages } = await src.load()
    expect(pdf).toBeNull()
    expect(pages).not.toBeNull()
    expect(sheets.map((s) => s.id)).toEqual(['5', '7'])
    expect(sheets[1].scale).toBe(50)
    const ctx = await src.contextFor('5')
    expect(ctx.origin).toBe('package')
    expect(ctx.items.find((i) => i.kind === 'wall')?.hostRef).toBe('1')
    expect(src.palette.walls.map((w) => w.name)).not.toContain('Generic - 300mm') // sheet scale unknown: not measured, defaults kept
  })

  it('reports a broken file by name and reason', async () => {
    const { raw } = tiny()
    const bad = raw.slice()
    new DataView(bad.buffer).setUint32(8, 9, true)
    await expect(openSource({ name: 'bad.drawing', bytes: bad })).rejects.toThrow(SourceError)
    await expect(openSource({ name: 'bad.drawing', bytes: bad })).rejects.toThrow(/bad\.drawing: unsupported .drawing version 9/)
    await expect(parseDrawingFile(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).rejects.toThrow(/could not decompress/)
  })
})
