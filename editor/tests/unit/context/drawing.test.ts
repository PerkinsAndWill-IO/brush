import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { contextFromDrawing, drawingPageType, furnitureSymbolsFromDrawing, paletteFromDrawing, roomAt, sheetInfo, sheetsFromDrawing, wallStylesFromDrawing } from '../../../src/core/context'
import { type DrawingPage, isDrawingPayload, parseDrawingPayload, parseLegacyDrawingPayload } from '../../../src/core/drawing'
import { BlobBuffer, buildPayload } from '../drawing/builder-legacy'

/** Rectangle outline as a closed path blob (feet). */
const rect = (b: BlobBuffer, x0: number, y0: number, x1: number, y1: number) => b.xy(x0, y0, x1, y0, x1, y1, x0, y1)

/** A 1:100 plan sheet (2 x 1 ft) with one wall, a door in it, a room, a desk, a grid and a room tag; plus an elevation. */
function fixture() {
  const b = new BlobBuffer()
  const items = [
    { t: 'path', pts: rect(b, 0.2, 0.5, 1.2, 0.51), closed: true, w: 0.001, el: 10, view: 5 },
    { t: 'fill', rings: [rect(b, 0.2, 0.5, 1.2, 0.51)], c: [0, 0, 0], el: 10, view: 5 },
    // door: jambs inside the wall band at x 0.5 and 0.55, leaf and swing outside it
    { t: 'segs', segs: b.xy(0.5, 0.5, 0.5, 0.51, 0.55, 0.5, 0.55, 0.51, 0.5, 0.51, 0.5, 0.56), w: 0.0005, el: 20, view: 5 },
    { t: 'fill', rings: [rect(b, 0.2, 0.51, 1.2, 0.9)], c: [220, 230, 255], el: 30, view: 5 },
    { t: 'path', pts: rect(b, 0.3, 0.6, 0.35, 0.62), closed: true, w: 0.0005, el: 40, view: 5 },
    { t: 'segs', segs: b.xy(0.1, 0.1, 0.1, 0.95), w: 0.0005, el: 50, view: 5 },
    { t: 'text', text: 'A', at: [0.1, 0.97], size: 0.008, anchor: 'cm', el: 50, view: 5 },
    { t: 'text', text: 'Office', at: [0.7, 0.7], size: 0.008, anchor: 'cm', el: 60, view: 5 },
    { t: 'path', pts: rect(b, 0, 0, 2, 1), closed: true, w: 0.002, el: 70 },
  ]
  const elevation = [{ t: 'path', pts: rect(b, 0.2, 0.2, 1.2, 0.5), closed: true, w: 0.001, el: 10, view: 6 }]
  const header = {
    format: 'drawing',
    version: 1,
    source: { file: 'tower.rvt' },
    pages: [
      { id: 900, kind: 'sheet', number: 'A-101', name: 'Level 1 Floor Plan', scale: null, min: [0, 0], max: [2, 1], items },
      { id: 901, kind: 'sheet', number: 'A-201', name: 'Elevations', scale: null, min: [0, 0], max: [2, 1], items: elevation },
    ],
    elements: {
      '10': { class: 'SWall', category: 'Walls', type: 'Generic - 300mm', params: [{ name: 'CURVE_ELEM_LENGTH', value: '30480' }] },
      '20': { class: 'FamilyInstance', category: 'Doors', family: 'Single-Flush', type: '900 x 2100' },
      '30': { class: 'RoomElem', category: 'Rooms', name: '101 Office' },
      '40': { class: 'FamilyInstance', category: 'Furniture', type: 'Desk 1400x500' },
      '50': { class: 'Grid', category: 'Grids', name: 'A' },
      '60': { class: 'RoomTag', category: null, tagged: 30 },
      '70': { class: 'FamilyInstance', category: 'Title Blocks' },
    },
  }
  return parseLegacyDrawingPayload(buildPayload(header, b.bytes()))
}

describe('M5-09 context from a .drawing (decision 0008)', () => {
  it('sheets: host ids, number, name, size in points, scale estimated from wall lengths', () => {
    const sheets = sheetsFromDrawing(fixture())
    expect(sheets.map((s) => [s.id, s.number, s.name, s.pageIndex])).toEqual([
      ['900', 'A-101', 'Level 1 Floor Plan', 0],
      ['901', 'A-201', 'Elevations', 1],
    ])
    expect(sheets[0].sizePt).toEqual({ w: 1728, h: 864 })
    expect(sheets[0].scale).toBe(100)
  })

  it('PERF-02: sheets can list every page while reading the items of only the first ones', () => {
    const doc = fixture()
    doc.pages[1].scale = '1 : 50'
    Object.defineProperty(doc.pages[1], 'items', {
      get: () => {
        throw new Error('page 901 was decoded')
      },
    })
    const sheets = sheetsFromDrawing(doc, 1)
    expect(sheets.map((s) => [s.id, s.scale])).toEqual([
      ['900', 100],
      ['901', 50],
    ])
  })

  it('plan context: wall centerline + thickness, door on its host wall, room, fixture, grid, labels; all host refs', () => {
    const ctx = contextFromDrawing(fixture(), '900')
    expect(ctx.origin).toBe('package')
    expect(ctx.scale).toBe(100)
    expect(ctx.items.every((i) => i.confidence === 1)).toBe(true)
    const byId = new Map(ctx.items.map((i) => [i.id, i]))

    const wall = byId.get('wall-10')!
    expect(wall.kind).toBe('wall')
    expect(wall.hostRef).toBe('10')
    expect(Number(wall.props!.thicknessPt)).toBeCloseTo(8.64, 1)
    const ys = wall.geometry.points.map((p) => p.y)
    ys.forEach((y) => expect(y).toBeCloseTo(864 * (1 - 0.505), 0))
    const xs = wall.geometry.points.map((p) => p.x).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(172.8, 0)
    expect(xs[1]).toBeCloseTo(1036.8, 0)
    expect(wall.props!.typeName).toBe('Generic - 300mm')

    const door = byId.get('opening-20')!
    expect(door.kind).toBe('opening')
    expect(door.props!.hostWall).toBe('10')
    expect(Number(door.props!.widthPt)).toBeCloseTo(43.2, 0)
    door.geometry.points.forEach((p) => expect(p.y).toBeCloseTo(864 * (1 - 0.505), 0))

    expect(byId.get('fixture-40')!.kind).toBe('fixture')
    expect(byId.get('grid-50')).toMatchObject({ kind: 'grid', text: 'A' })
    expect(byId.has('unknown-70')).toBe(false) // title block: no context item

    const room = roomAt(ctx, { x: 864 * 0.7, y: 864 * 0.3 })
    expect(room.label).toBe('101 Office')
    expect(room.areaM2).toBeCloseTo(30.48 * 11.89, 0)

    const tag = ctx.items.find((i) => i.kind === 'label' && i.text === 'Office')!
    expect(tag.props).toMatchObject({ role: 'room', tagged: '30' })
    expect(sheetInfo(ctx)).toMatchObject({ sheetType: 'plan', number: 'A-101', title: 'Level 1 Floor Plan' })
  })

  it('non-plan pages keep elements targetable but emit no plan geometry kinds', () => {
    const ctx = contextFromDrawing(fixture(), '901')
    expect(ctx.items.some((i) => i.kind === 'wall')).toBe(false)
    expect(ctx.items.find((i) => i.hostRef === '10')!.kind).toBe('unknown')
    expect(sheetInfo(ctx)!.sheetType).toBe('elevation')
  })

  it('palette: the model types with measured sizes', () => {
    const p = paletteFromDrawing(fixture())
    expect(p.walls).toEqual([{ name: 'Generic - 300mm', thicknessMm: 305 }])
    expect(p.doors).toEqual([{ name: 'Single-Flush 900 x 2100', widthMm: 900, heightMm: 2100 }])
    expect(p.furniture[0]).toMatchObject({ name: 'Desk 1400x500', widthMm: 1525, depthMm: 610 })
  })

  const house = resolve(__dirname, '../../../../schema/public/examples/house.drawing')
  it.skipIf(!existsSync(house))('reads the schema example (house.drawing): three pages, plan context with walls, doors, rooms', () => {
    const doc = parseLegacyDrawingPayload(new Uint8Array(gunzipSync(readFileSync(house))))
    const sheets = sheetsFromDrawing(doc)
    expect(sheets.map((s) => s.number ?? s.name)).toEqual(['A102', 'A103', '{3D}'])
    const ctx = contextFromDrawing(doc, sheets[0].id)
    expect(ctx.scale).toBe(100)
    const count = (k: string) => ctx.items.filter((i) => i.kind === k).length
    expect(count('wall')).toBeGreaterThan(30)
    expect(count('opening')).toBeGreaterThan(20)
    expect(ctx.items.filter((i) => i.props?.role === 'room').length).toBeGreaterThan(10)
    expect(ctx.items.filter((i) => i.kind === 'opening' && i.props?.hostWall).length).toBeGreaterThan(20)
  })
})

describe('M5 furniture symbols from a .drawing', () => {
  const house = resolve(__dirname, '../../../../schema/public/examples/house.drawing')
  it.skipIf(!existsSync(house))('M3-03: every furniture type on the plan has its own symbol, normalised to its box', () => {
    const doc = parseLegacyDrawingPayload(new Uint8Array(gunzipSync(readFileSync(house))))
    const syms = furnitureSymbolsFromDrawing(doc)
    for (const f of paletteFromDrawing(doc).furniture) expect(syms.has(f.name)).toBe(true)
    const bar = syms.get('Bar Chair')!
    expect(bar.lines.length).toBeGreaterThan(10)
    expect(bar.widthPt).toBeCloseTo(bar.depthPt, 0)
    for (const l of bar.lines) for (const p of l.pts) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeLessThanOrEqual(0.5 + 1e-3)
  })

  it('M3-03: the desk of the built fixture becomes a symbol with its outline', () => {
    const syms = furnitureSymbolsFromDrawing(fixture())
    const desk = syms.get('Desk 1400x500')!
    expect(desk.lines).toHaveLength(1)
    expect(desk.lines[0].closed).toBe(true)
    expect(desk.widthPt / desk.depthPt).toBeCloseTo(2.5, 1)
  })
})

describe('M5 wall styles from a .drawing', () => {
  const house = resolve(__dirname, '../../../../schema/public/examples/house.drawing')
  it.skipIf(!existsSync(house))('M3-03: every wall type on the plan has its linework: heavy faces at ±0.5, layer lines between', () => {
    const doc = parseLegacyDrawingPayload(new Uint8Array(gunzipSync(readFileSync(house))))
    const styles = wallStylesFromDrawing(doc)
    for (const w of paletteFromDrawing(doc).walls) expect(styles.has(w.name)).toBe(true)
    for (const [, s] of styles) {
      const offs = s.lines.map((l) => l.offset)
      expect(offs[0]).toBe(-0.5)
      expect(offs[offs.length - 1]).toBe(0.5)
      expect(offs).toEqual([...offs].sort((a, b) => a - b))
      for (const l of s.lines) expect(Math.abs(l.offset)).toBeLessThanOrEqual(0.5)
    }
    // Wall - Timber Clad on A102 (1:100): faces 5.72 pt apart (about 202 mm), drawn heavier than its five layer lines
    // and its location line; white fills behind the layers
    const timber = styles.get('Wall - Timber Clad')!
    expect(timber.thicknessPt).toBeCloseTo(5.72, 0)
    expect(timber.thicknessMm!).toBeGreaterThan(195)
    expect(timber.thicknessMm!).toBeLessThan(210)
    const faces = timber.lines.filter((l) => Math.abs(l.offset) === 0.5)
    const inner = timber.lines.filter((l) => Math.abs(l.offset) < 0.5)
    expect(faces).toHaveLength(2)
    expect(inner.length).toBeGreaterThanOrEqual(5)
    for (const l of inner) expect(l.weightPt).toBeLessThan(faces[0].weightPt)
    expect(inner.some((l) => Math.abs(l.offset) < 0.02)).toBe(true) // the location line
    expect(timber.fills.length).toBeGreaterThan(0)
    expect(timber.fills.every((f) => f.color.every((c) => c === 255))).toBe(true)
    // the 165 partition reads thinner than the timber wall
    expect(styles.get('Interior - 165 Partition (1-hr)')!.thicknessMm!).toBeLessThan(timber.thicknessMm!)
  })

  it('M3-03: the wall of the built fixture: two faces and its solid poché across the whole thickness', () => {
    const s = wallStylesFromDrawing(fixture()).get('Generic - 300mm')!
    expect(s.lines.map((l) => l.offset)).toEqual([-0.5, 0.5])
    expect(s.thicknessPt).toBeCloseTo(8.64, 1)
    expect(s.thicknessMm).toBeCloseTo(304.8, 0)
    expect(s.fills).toEqual([{ from: -0.5, to: 0.5, color: [0, 0, 0] }])
  })
})

describe('M2 scale from wall lengths written in metres', () => {
  const kro = resolve(__dirname, '../../../../schema/public/examples/kro/kro-test-lean.drawing')
  it.skipIf(!existsSync(kro))('M2-05: kro-test-lean (CURVE_ELEM_LENGTH in m) gets a scale, so the palette and wall styles are its own types', () => {
    const raw = new Uint8Array(readFileSync(kro))
    const doc = isDrawingPayload(raw) ? parseDrawingPayload(raw) : parseLegacyDrawingPayload(new Uint8Array(gunzipSync(raw)))
    const plan = sheetsFromDrawing(doc)[0]
    expect(contextFromDrawing(doc, plan.id).scale).toBeGreaterThan(0)
    const walls = paletteFromDrawing(doc).walls
    expect(walls.every((w) => w.name.startsWith('MUR_'))).toBe(true)
    // the type a sketched wall gets is one whose linework the editor can draw
    const styles = wallStylesFromDrawing(doc)
    expect(walls.filter((w) => styles.has(w.name)).length).toBeGreaterThan(10)
    expect(styles.get('MUR_BA 30cm')!.thicknessMm).toBeCloseTo(300, -1)
  })
})

describe('drawing page view type', () => {
  const page = (name: string, viewType?: 'plan' | 'section' | 'ceiling'): DrawingPage => ({
    id: '1', kind: 'view', number: null, name, scale: null, sizePt: { w: 10, h: 10 }, items: [], ...(viewType ? { viewType } : {}),
  })
  it('the file view type decides the sheet type over the title words', () => {
    expect(drawingPageType(page('Level 1', 'section'))).toBe('section')
    expect(drawingPageType(page('Section A', 'plan'))).toBe('plan')
  })
  it('a type the table does not cover, or none, falls back to the title words', () => {
    expect(drawingPageType(page('Level 1 Elevation', 'ceiling'))).toBe('elevation')
    expect(drawingPageType(page('Level 1 Elevation'))).toBe('elevation')
  })
})
