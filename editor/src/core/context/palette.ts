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
/**
 * A furniture type's footprint read from its name, mm, for types listed without a size (the Revit link sends 0 x 0):
 * `72" x 30"`, `96" x 12" x 84"` (the first two), `36" Diameter`, `500mm Diameter`, `1200 x 600mm`.
 */
export function footprintFromName(name: string): { widthMm: number; depthMm: number } | null {
  const n = name.replace(/[″”]/g, '"')
  const unit = (u: string | undefined) => (u && /^(mm)$/i.test(u) ? 1 : u && /^cm$/i.test(u) ? 10 : u === '"' ? 25.4 : u === "'" ? 304.8 : 0)
  const pair = n.match(/(\d+(?:\.\d+)?)\s*("|mm|cm)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*("|mm|cm)?/i)
  if (pair) {
    const u = unit(pair[2] ?? pair[4])
    if (u) return { widthMm: parseFloat(pair[1]) * u, depthMm: parseFloat(pair[3]) * u }
  }
  const dia = n.match(/(\d+(?:\.\d+)?)\s*("|mm|cm)\s*(?:diameter|dia\b|ø)/i)
  if (dia) {
    const d = parseFloat(dia[1]) * unit(dia[2])
    return { widthMm: d, depthMm: d }
  }
  return null
}

/**
 * Furniture family whose footprint is closest to `widthM` x `depthM` (either orientation). A type without a size uses
 * the one in its name; types with no size at all are picked only when none has one.
 */
export function nearestFurnitureFamily(palette: TypePalette, widthM: number, depthM: number) {
  return nearestFurniture(palette, widthM, depthM)
}

/** A furniture type's footprint, mm: its own, else the one in its name, else 0 x 0. */
export function furnitureSizeMm(f: TypePalette['furniture'][number]): { widthMm: number; depthMm: number } {
  if (f.widthMm > 0 && f.depthMm > 0) return { widthMm: f.widthMm, depthMm: f.depthMm }
  return footprintFromName(f.name) ?? { widthMm: 0, depthMm: 0 }
}

/**
 * Nearest furniture type by footprint, each candidate's distance scaled by `weight` (below 1 favours it). Types with no
 * known size take part only when none has one.
 */
export function nearestFurniture(palette: TypePalette, widthM: number, depthM: number, weight: (name: string) => number = () => 1) {
  const a = Math.max(widthM, depthM) * 1000
  const b = Math.min(widthM, depthM) * 1000
  const sized = palette.furniture.map((f) => {
    const s = furnitureSizeMm(f)
    return { f, w: s.widthMm, d: s.depthMm }
  })
  const known = sized.filter((s) => s.w > 0 && s.d > 0)
  if (!known.length) return palette.furniture[0]
  let best: TypePalette['furniture'][number] | undefined
  let bd = Infinity
  for (const { f, w, d: dd } of known) {
    const d = Math.hypot(Math.max(w, dd) - a, Math.min(w, dd) - b) * weight(f.name)
    if (d < bd) {
      bd = d
      best = f
    }
  }
  return best
}
