import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { commandFromDecision } from '../../../src/core/commands'
import type { Command, Sheet } from '../../../src/core/types'
import {
  buildCommandFile,
  commandFileName,
  openSource,
  parseCommandFile,
  parsePackage,
  serializeCommandFile,
  serializePackage,
  sniffBytes,
  writeCommandFile,
  PackageError,
  SourceError,
} from '../../../src/app/source'

const fx = (p: string) => new Uint8Array(readFileSync(resolve(__dirname, '../../../fixtures', p)))

const tiny = {
  schemaVersion: 1 as const,
  project: 'P',
  sheets: [
    {
      id: 'A-1',
      name: 'Plan',
      sizePt: { w: 100, h: 100 },
      scale: 100,
      elements: [
        { id: '77', category: 'Walls', typeName: 'Generic - 200mm', footprint: [{ x: 0, y: 10 }, { x: 90, y: 10 }] },
        { id: '78', category: 'Rooms', label: 'R1', footprint: [{ x: 0, y: 0 }, { x: 9, y: 0 }, { x: 9, y: 9 }] },
      ],
    },
  ],
}
const enc = (s: string) => new TextEncoder().encode(s)

function zip(files: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let off = 0
  for (const f of files) {
    const body = f.deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data
    const name = enc(f.name)
    const lh = new Uint8Array(30 + name.length)
    const dv = new DataView(lh.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(8, f.deflate ? 8 : 0, true)
    dv.setUint32(18, body.length, true)
    dv.setUint32(22, f.data.length, true)
    dv.setUint16(26, name.length, true)
    lh.set(name, 30)
    const ch = new Uint8Array(46 + name.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, f.deflate ? 8 : 0, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, off, true)
    ch.set(name, 46)
    parts.push(lh, body)
    central.push(ch)
    off += lh.length + body.length
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, off, true)
  return Uint8Array.from([...parts, ...central, end].flatMap((p) => [...p]))
}

describe('M5 package parsing and sniffing', () => {
  it('M5-01 sniffs pdf, json package and zip by content', () => {
    expect(sniffBytes(fx('pdfs/office-1-sheet.pdf'))).toBe('pdf')
    expect(sniffBytes(fx('packages/office-1-sheet.drawing'))).toBe('package-json')
    expect(sniffBytes(zip([{ name: 'manifest.json', data: enc('{}') }]))).toBe('package-zip')
    expect(sniffBytes(fx('pdfs/not-a-pdf.txt'))).toBe('unknown')
  })

  it('M5-02 parses the fixture package: manifest and embedded PDF', async () => {
    const p = await parsePackage(fx('packages/office-6-sheets.drawing'))
    expect(p.manifest.sheets).toHaveLength(6)
    expect(p.manifest.sheets[0].number).toBe('A-101')
    expect(sniffBytes(p.pdf!.bytes!)).toBe('pdf')
  })

  it('M5-02 parses a zip (stored and deflate) and tolerates unknown keys and missing arrays', async () => {
    const pdf = fx('pdfs/office-1-sheet.pdf')
    const m = enc(JSON.stringify({ ...tiny, extra: 1, sheets: [{ id: 'A-1', sizePt: { w: 1, h: 1 } }] }))
    for (const deflate of [false, true]) {
      const p = await parsePackage(zip([{ name: 'x/manifest.json', data: m, deflate }, { name: 'x/plan.pdf', data: pdf, deflate }]))
      expect(p.container).toBe('zip')
      expect(p.manifest.sheets[0].elements).toEqual([])
      expect(p.pdf!.bytes!.length).toBe(pdf.length)
    }
  })

  it('M5-02 rejects bad schema version and missing sheets', async () => {
    await expect(parsePackage(enc('{"schemaVersion":2,"sheets":[]}'))).rejects.toBeInstanceOf(PackageError)
    await expect(parsePackage(enc('{"schemaVersion":1}'))).rejects.toBeInstanceOf(PackageError)
    await expect(parsePackage(enc('{nope'))).rejects.toBeInstanceOf(PackageError)
  })

  it('M5-02 envelope round-trip', async () => {
    const pdf = fx('pdfs/office-1-sheet.pdf')
    const p = await parsePackage(enc(serializePackage(tiny, { name: 'a.pdf', bytes: pdf })))
    expect(p.manifest).toMatchObject({ project: 'P', sheets: [{ id: 'A-1', scale: 100 }] })
    expect(p.pdf!.bytes).toEqual(pdf)
  })
})

describe('M5 sources', () => {
  it('M5-03 PackageSource: sheets from the manifest, contexts origin package with hostRefs', async () => {
    const src = await openSource({ name: 'office-6-sheets.drawing', bytes: fx('packages/office-6-sheets.drawing') })
    expect(src.kind).toBe('package')
    const ctx = await src.contextFor('A-301')
    expect(ctx.origin).toBe('package')
    expect(ctx.items.length).toBeGreaterThan(50)
    expect(ctx.items.every((i) => i.confidence === 1 && typeof i.hostRef === 'string')).toBe(true)
    expect(ctx.items.find((i) => i.kind === 'wall')!.props?.typeName).toMatch(/mm$/)
    expect(src.palette.walls.length).toBeGreaterThan(0)
  })

  it('M5-03 package without PDF loads blank sheets', async () => {
    const src = await openSource({ name: 't.drawing', bytes: enc(JSON.stringify(tiny)) })
    const l = await src.load()
    expect(l.pdf).toBeNull()
    expect(l.sheets).toEqual([{ id: 'A-1', name: 'Plan', sizePt: { w: 100, h: 100 }, pageIndex: 0, scale: 100 }])
  })

  it('M5-04 openSource sniffs a PDF and rejects garbage', async () => {
    const src = await openSource({ name: 'x.pdf', bytes: fx('pdfs/office-1-sheet.pdf') })
    expect(src.kind).toBe('pdf')
    await expect(openSource({ name: 'x.txt', bytes: fx('pdfs/not-a-pdf.txt') })).rejects.toBeInstanceOf(SourceError)
    await expect(openSource({ name: 'bad.drawing', bytes: enc('{"schemaVersion":9}') })).rejects.toBeInstanceOf(SourceError)
  })

  it('M5-05 package hostRef flows into commands', async () => {
    const src = await openSource({ name: 't.drawing', bytes: enc(JSON.stringify(tiny)) })
    const ctx = await src.contextFor('A-1')
    const wallItem = ctx.items.find((i) => i.kind === 'wall')!
    const cmd = commandFromDecision(
      { strokeId: 's', sheetId: 'A-1', kind: 'delete', geometry: { points: [], closed: false }, confidence: 1, targets: [wallItem.id], committedAt: 0 },
      'cmd-0001',
      ctx,
    )
    expect(cmd).toMatchObject({ op: 'delete', targets: ['77'] })
  })
})

describe('M5 command file', () => {
  const sheets: Sheet[] = [{ id: 'A-1', name: 'Plan', number: 'A-1', sizePt: { w: 1, h: 1 }, pageIndex: 0, scale: 100 }]
  const commands: Command[] = [
    { op: 'create_wall', id: 'cmd-0001', sheetId: 'A-1', path: { points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], closed: false }, wallType: 'Generic - 200mm', strokeId: 's1' },
    { op: 'delete', id: 'cmd-0002', sheetId: 'A-1', targets: ['77'], strokeId: 's2' },
  ]

  it('M5-06 serialises and parses back identically', () => {
    const f = buildCommandFile({ source: { name: 'p.drawing', kind: 'package', project: 'P' }, sheets, commands })
    const text = serializeCommandFile(f)
    expect(parseCommandFile(text)).toEqual(f)
    expect(serializeCommandFile(parseCommandFile(text))).toBe(text)
  })

  it('M5-06 rejects foreign or unknown content', () => {
    expect(() => parseCommandFile('{"kind":"other"}')).toThrow()
    const f = buildCommandFile({ source: { name: 'p.pdf', kind: 'pdf' }, sheets, commands })
    const bad = serializeCommandFile(f).replace('"delete"', '"explode"')
    expect(() => parseCommandFile(bad)).toThrow(/unknown command op/)
  })

  it('M5-06 names the file next to the source and writes via the platform save', async () => {
    expect(commandFileName('Tower A.pdf')).toBe('Tower A.commands.json')
    expect(commandFileName('Tower A.drawing')).toBe('Tower A.commands.json')
    const saved: Array<[string, string]> = []
    const f = buildCommandFile({ source: { name: 'p.pdf', kind: 'pdf' }, sheets, commands })
    const name = await writeCommandFile(async (n, t) => void saved.push([n, t]), f)
    expect(name).toBe('p.commands.json')
    expect(parseCommandFile(saved[0][1]).commands).toHaveLength(2)
  })
})
