import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PALETTE,
  contextFromPackage,
  nearestDoorFamily,
  nearestWallType,
  paletteFromPackage,
  roomAt,
  sheetsFromPackage,
  vectorPageFromPackage,
  type DrawingManifest,
} from '../../../src/core/context'
import { elementAt } from '../../../src/app/drawing/inspect'

const manifest: DrawingManifest = {
  schemaVersion: 1,
  sheets: [
    {
      id: 'A-201',
      number: 'A-201',
      name: 'Level 2',
      sizePt: { w: 2384, h: 1684 },
      scale: 100,
      elements: [
        { id: '1', category: 'Walls', typeName: 'Generic - 200mm', footprint: [{ x: 100, y: 100 }, { x: 400, y: 100 }] },
        { id: '2', category: 'Doors', footprint: [{ x: 200, y: 100 }, { x: 225, y: 100 }] },
        { id: '3', category: 'Grids', label: 'A', footprint: [{ x: 50, y: 0 }, { x: 50, y: 500 }] },
        {
          id: '4',
          category: 'Rooms',
          label: 'OFFICE 201',
          footprint: [{ x: 104, y: 104 }, { x: 396, y: 104 }, { x: 396, y: 296 }, { x: 104, y: 296 }],
        },
        { id: '5', category: 'Furniture', footprint: [{ x: 150, y: 150 }, { x: 190, y: 150 }, { x: 190, y: 170 }, { x: 150, y: 170 }] },
      ],
    },
  ],
}

describe('contextFromPackage', () => {
  it('maps elements with confidence 1 and hostRef', () => {
    const ctx = contextFromPackage(manifest, 'A-201')
    expect(ctx.origin).toBe('package')
    expect(ctx.scale).toBe(100)
    expect(ctx.items.map((i) => i.kind)).toEqual(['wall', 'opening', 'grid', 'unknown', 'fixture'])
    for (const i of ctx.items) {
      expect(i.confidence).toBe(1)
      expect(i.hostRef).toBeDefined()
    }
    expect(ctx.items[0].props?.typeName).toBe('Generic - 200mm')
    expect(ctx.items[1].props?.widthPt).toBe('25')
    expect(ctx.items[3].geometry.closed).toBe(true)
  })

  it('roomAt works on package rooms', () => {
    const ctx = contextFromPackage(manifest)
    const r = roomAt(ctx, { x: 200, y: 200 })
    expect(r.label).toBe('OFFICE 201')
    expect(r.areaM2).toBeCloseTo(((292 * 192 * (25.4 / 72) ** 2 * 100 ** 2) / 1e6), 3)
  })

  it('lists sheets and throws on an unknown sheet', () => {
    expect(sheetsFromPackage(manifest)[0]).toMatchObject({ id: 'A-201', number: 'A-201', pageIndex: 0, scale: 100 })
    expect(() => contextFromPackage(manifest, 'nope')).toThrow()
  })
})

describe('palette', () => {
  it('falls back to defaults and honours manifest types', () => {
    expect(paletteFromPackage(manifest)).toEqual(DEFAULT_PALETTE)
    const p = paletteFromPackage({ ...manifest, palette: { walls: [{ name: 'W1', thicknessMm: 123 }] } })
    expect(p.walls).toEqual([{ name: 'W1', thicknessMm: 123 }])
    expect(p.doors).toEqual(DEFAULT_PALETTE.doors)
  })
  it('finds nearest types', () => {
    expect(nearestWallType(DEFAULT_PALETTE, 0.19)?.name).toBe('Generic - 200mm')
    expect(nearestDoorFamily(DEFAULT_PALETTE, 0.95)?.widthMm).toBeGreaterThanOrEqual(900)
  })
})

describe('vectorPageFromPackage: a pickable page for a JSON package sheet (Revit link)', () => {
  const sheet = {
    id: '382617',
    number: 'A103',
    name: 'Third Floor Plan',
    sizePt: { w: 1191, h: 842 },
    scale: 100,
    elements: [
      { id: 'w1', category: 'Walls', typeName: 'Generic - 200mm', footprint: [{ x: 100, y: 100 }, { x: 500, y: 100 }], props: { level: 'Level 3', thicknessMm: '200' } },
      { id: 'r1', category: 'Rooms', label: 'Kitchen', footprint: [{ x: 50, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 400 }, { x: 50, y: 400 }] },
      { id: 'f1', category: 'Furniture', typeName: 'Desk: 1600x800', footprint: [{ x: 200, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 260 }, { x: 200, y: 260 }] },
      { id: 'empty', category: 'Text', footprint: [] },
    ],
  }
  const { page, elements } = vectorPageFromPackage(sheet)

  it('describes each element from the manifest: category, type, label, level and the other props as parameters', () => {
    expect(elements.w1).toEqual({ category: 'Walls', type: 'Generic - 200mm', level: 'Level 3', params: [{ name: 'thicknessMm', value: '200' }] })
    expect(elements.r1).toEqual({ category: 'Rooms', name: 'Kitchen' })
    expect(elements.empty).toBeUndefined()
    expect(page).toMatchObject({ id: '382617', kind: 'sheet', number: 'A103', scale: '1 : 100', sizePt: { w: 1191, h: 842 } })
  })

  it('picks the wall on its line, the furniture inside its outline over the room, and the room elsewhere inside it', () => {
    expect(elementAt(page, 300, 101, 2)).toBe('w1')
    expect(elementAt(page, 250, 230, 2)).toBe('f1')
    expect(elementAt(page, 450, 300, 2)).toBe('r1')
    expect(elementAt(page, 900, 700, 2)).toBeNull()
  })

  it("lists a Revit element's parameters, without the ones General shows or that only mean none", () => {
    const { elements: els } = vectorPageFromPackage({
      ...sheet,
      elements: [
        {
          id: 'w9',
          category: 'Walls',
          typeName: 'Exterior',
          footprint: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
          props: { level: 'L2', Category: 'Walls', Type: 'Exterior', 'Type Id': '12', 'Design Option': '-1', 'Unconnected Height': "57' - 11\"", 'Top Constraint': 'Up to level: Parapet' },
        },
      ],
    })
    expect(els.w9.params).toEqual([
      { name: 'Unconnected Height', value: "57' - 11\"" },
      { name: 'Top Constraint', value: 'Up to level: Parapet' },
    ])
  })
})
