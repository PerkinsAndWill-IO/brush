import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PALETTE,
  contextFromPackage,
  nearestDoorFamily,
  nearestWallType,
  paletteFromPackage,
  roomAt,
  sheetsFromPackage,
  type DrawingManifest,
} from '../../../src/core/context'

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
