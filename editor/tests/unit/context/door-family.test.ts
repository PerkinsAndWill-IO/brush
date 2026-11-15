import { describe, expect, it } from 'vitest'
import { DEFAULT_PALETTE, nearestDoorFamily } from '../../../src/core/context'
import type { TypePalette } from '../../../src/core/context'

const door = (name: string, widthMm: number) => ({ name, widthMm })
// Snowdon Towers' doors, in the order the Revit link lists them
const snowdon: TypePalette = {
  ...DEFAULT_PALETTE,
  doors: [
    door('Door-Curtain-Wall-Double-Storefront: Door-Curtain-Wall-Double-Storefront', 0),
    door('Door-Exterior-Revolving-Full Glass-Metal: 78" x 108"', 1981),
    door('Door-Opening: 36" x 80"', 0),
    door('Door-Passage-Double-Flush: 72" x 80"', 1829),
    door('Door-Passage-Single-Flush-Dbl_Acting: 36" x 80"', 914),
    door('Door-Passage-Single-Flush-Dbl_Acting: 42" x 80"', 1067),
    door('Door-Passage-Single-Flush: 30" x 80"', 762),
    door('Door-Passage-Single-Flush: 36" x 80"', 914),
    door('Door-Passage-Single-Flush: 36" x 84" (90 MIN)', 914),
    door('Door-Passage-Single-Flush: 42" x 96" (Exterior)', 1067),
  ],
}

describe('nearestDoorFamily: an ordinary door for a sketched opening', () => {
  it('a ~1 m opening is a plain single-flush door, not the double-acting one listed first (it draws at an angle)', () => {
    expect(nearestDoorFamily(snowdon, 1.02)?.name).toBe('Door-Passage-Single-Flush: 36" x 80"')
    expect(nearestDoorFamily(snowdon, 0.91)?.name).toBe('Door-Passage-Single-Flush: 36" x 80"')
  })

  it('still follows the width: narrow, double and very wide openings', () => {
    expect(nearestDoorFamily(snowdon, 0.76)?.name).toBe('Door-Passage-Single-Flush: 30" x 80"')
    expect(nearestDoorFamily(snowdon, 1.8)?.name).toBe('Door-Passage-Double-Flush: 72" x 80"')
    // only a specialty door is that wide
    expect(nearestDoorFamily(snowdon, 2.0)?.name).toBe('Door-Exterior-Revolving-Full Glass-Metal: 78" x 108"')
  })

  it('keeps working with the built-in palette', () => {
    expect(nearestDoorFamily(DEFAULT_PALETTE, 0.95)?.widthMm).toBeGreaterThanOrEqual(900)
  })
})
