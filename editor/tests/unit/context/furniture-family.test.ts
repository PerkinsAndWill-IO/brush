import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE, footprintFromName, nearestFurnitureFamily } from '../../../src/core/context'
import type { TypePalette } from '../../../src/core/context'

const zero = (name: string) => ({ name, widthMm: 0, depthMm: 0 })
// what the Revit link sends for Snowdon Towers: every family, no sizes
const snowdon: TypePalette = {
  ...DEFAULT_PALETTE,
  furniture: [
    zero('Banquette - Double: Banquette - Double'),
    zero('Bed-Shaker: Queen 62" x 83"'),
    zero('Shelving: 96" x 12" x 84"'),
    zero('Table-Dining Round w Chairs: 60" Diameter'),
    zero('Table-Rectangular: 72" x 30"'),
    zero('Table-Trio End: 500mm Diameter'),
  ],
}

describe('furniture families without sizes (Revit link palette)', () => {
  it('reads a footprint from the type name', () => {
    expect(footprintFromName('Table-Rectangular: 72" x 30"')).toEqual({ widthMm: 72 * 25.4, depthMm: 30 * 25.4 })
    expect(footprintFromName('Shelving: 96" x 12" x 84"')).toEqual({ widthMm: 96 * 25.4, depthMm: 12 * 25.4 })
    expect(footprintFromName('Table-Dining Round w Chairs: 60" Diameter')).toEqual({ widthMm: 60 * 25.4, depthMm: 60 * 25.4 })
    expect(footprintFromName('Table-Trio End: 500mm Diameter')).toEqual({ widthMm: 500, depthMm: 500 })
    expect(footprintFromName('Banquette - Double: Banquette - Double')).toBeNull()
  })

  it('a table-sized rectangle becomes the table, not the first family in the list', () => {
    expect(nearestFurnitureFamily(snowdon, 1.8, 0.8)?.name).toBe('Table-Rectangular: 72" x 30"')
    expect(nearestFurnitureFamily(snowdon, 1.6, 2.1)?.name).toBe('Bed-Shaker: Queen 62" x 83"')
    expect(nearestFurnitureFamily(snowdon, 0.5, 0.5)?.name).toBe('Table-Trio End: 500mm Diameter')
  })

  it('with no size anywhere it still answers (the first family)', () => {
    expect(nearestFurnitureFamily({ ...DEFAULT_PALETTE, furniture: [zero('A'), zero('B')] }, 1, 1)?.name).toBe('A')
  })
})

describe('room preference with sizes from names', () => {
  it('an "Office" room prefers desks, but with no desk the size still decides (not the first family)', async () => {
    const { nearestFurniture } = await import('../../../src/core/context')
    const officeWeight = (name: string) => (/desk/i.test(name) ? 0.6 : 1)
    expect(nearestFurniture(snowdon, 1.9, 0.81, officeWeight)?.name).toBe('Table-Rectangular: 72" x 30"')
  })
})
