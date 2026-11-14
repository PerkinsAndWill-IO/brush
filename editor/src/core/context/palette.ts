import type { DrawingManifest, TypePalette } from './package-format'

/** Built-in types offered when the source is a plain PDF. */
export const DEFAULT_PALETTE: TypePalette = {
  walls: [
    { name: 'Partition - 100mm', thicknessMm: 100 },
    { name: 'Interior - 150mm', thicknessMm: 150 },
    { name: 'Generic - 200mm', thicknessMm: 200 },
    { name: 'Exterior - 300mm', thicknessMm: 300 },
    { name: 'Concrete - 400mm', thicknessMm: 400 },
  ],
  doors: [
    { name: 'Single-Flush 0800x2100', widthMm: 800, heightMm: 2100 },
    { name: 'Single-Flush 0900x2100', widthMm: 900, heightMm: 2100 },
    { name: 'Single-Flush 1000x2100', widthMm: 1000, heightMm: 2100 },
    { name: 'Double-Flush 1800x2100', widthMm: 1800, heightMm: 2100 },
  ],
  furniture: [
    { name: 'Desk 1600x800', widthMm: 1600, depthMm: 800 },
    { name: 'Table 1800x900', widthMm: 1800, depthMm: 900 },
    { name: 'Chair 500x500', widthMm: 500, depthMm: 500 },
    { name: 'Sofa 2000x900', widthMm: 2000, depthMm: 900 },
    { name: 'Bed 1600x2000', widthMm: 1600, depthMm: 2000 },
  ],
}

/** Palette of a package: manifest types where given, built-in defaults otherwise. */
export function paletteFromPackage(manifest: DrawingManifest): TypePalette {
  const p = manifest.palette ?? {}
  return {
    walls: p.walls?.length ? p.walls : DEFAULT_PALETTE.walls,
    doors: p.doors?.length ? p.doors : DEFAULT_PALETTE.doors,
    furniture: p.furniture?.length ? p.furniture : DEFAULT_PALETTE.furniture,
  }
}

function nearest<T>(list: T[], value: number, get: (t: T) => number): T | undefined {
  let best: T | undefined
  let bd = Infinity
  for (const t of list) {
    const d = Math.abs(get(t) - value)
    if (d < bd) {
      bd = d
      best = t
    }
  }
  return best
}

/** Wall type whose thickness is closest to `thicknessM`. */
export function nearestWallType(palette: TypePalette, thicknessM: number) {
  return nearest(palette.walls, thicknessM * 1000, (w) => w.thicknessMm)
}
/** Door family whose width is closest to `widthM`. */
export function nearestDoorFamily(palette: TypePalette, widthM: number) {
  return nearest(palette.doors, widthM * 1000, (d) => d.widthMm)
}
/** Furniture family whose footprint is closest to `widthM` x `depthM` (either orientation). */
export function nearestFurnitureFamily(palette: TypePalette, widthM: number, depthM: number) {
  const a = Math.max(widthM, depthM) * 1000
  const b = Math.min(widthM, depthM) * 1000
  let best: TypePalette['furniture'][number] | undefined
  let bd = Infinity
  for (const f of palette.furniture) {
    const d = Math.hypot(Math.max(f.widthMm, f.depthMm) - a, Math.min(f.widthMm, f.depthMm) - b)
    if (d < bd) {
      bd = d
      best = f
    }
  }
  return best
}
