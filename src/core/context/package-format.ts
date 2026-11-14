import type { Point } from '../types'

/**
 * Minimal manifest of a future `.drawing` package (see docs/decisions/0002-drawing-package-manifest.md).
 * All coordinates are sheet points (1/72 in), origin top-left, y down, matching core/types.
 */
export const DRAWING_MANIFEST_VERSION = 1

export type ElementCategory =
  | 'Walls'
  | 'Doors'
  | 'Windows'
  | 'Grids'
  | 'Rooms'
  | 'Furniture'
  | 'Casework'
  | 'Text'
  | (string & {})

export interface ManifestElement {
  /** Host model element id. Becomes ContextItem.hostRef. */
  id: string
  category: ElementCategory
  /**
   * Footprint on the sheet. Walls and Grids: centerline polyline (open). Doors/Windows: the opening
   * segment or its outline. Rooms/Furniture: closed polygon.
   */
  footprint: Point[]
  /** Override closed/open; defaults by category (Rooms, Furniture, Casework closed). */
  closed?: boolean
  /** Host type name, e.g. "Generic - 200mm" or "Single-Flush 0915x2134". */
  typeName?: string
  /** Room name / grid name / text content. */
  label?: string
  /** Free-form string properties (level, fire rating, thickness...). */
  props?: Record<string, string>
}

export interface ManifestSheet {
  id: string
  number?: string
  name: string
  sizePt: { w: number; h: number }
  scale?: number
  elements: ManifestElement[]
}

export interface WallTypeDef {
  name: string
  thicknessMm: number
}
export interface DoorFamilyDef {
  name: string
  widthMm: number
  heightMm?: number
}
export interface FurnitureFamilyDef {
  name: string
  widthMm: number
  depthMm: number
}

/** Palette of types the host model offers (or the built-in default for plain PDFs). */
export interface TypePalette {
  walls: WallTypeDef[]
  doors: DoorFamilyDef[]
  furniture: FurnitureFamilyDef[]
}

export interface DrawingManifest {
  schemaVersion: typeof DRAWING_MANIFEST_VERSION
  project?: string
  sheets: ManifestSheet[]
  /** Optional: the host model's own types. Falls back to DEFAULT_PALETTE. */
  palette?: Partial<TypePalette>
}
