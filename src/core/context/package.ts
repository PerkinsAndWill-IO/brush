import type { ContextItem, ContextItemKind, Sheet, SheetContext } from '../types'
import { bboxOf } from './internal/math'
import type { DrawingManifest, ManifestElement } from './package-format'

const CLOSED_BY_DEFAULT = new Set(['Rooms', 'Furniture', 'Casework'])

function kindOf(category: string): ContextItemKind {
  switch (category) {
    case 'Walls':
      return 'wall'
    case 'Doors':
    case 'Windows':
      return 'opening'
    case 'Grids':
      return 'grid'
    case 'Furniture':
    case 'Casework':
      return 'fixture'
    case 'Text':
      return 'label'
    default:
      return 'unknown'
  }
}

function itemOf(e: ManifestElement): ContextItem {
  const kind = kindOf(e.category)
  const closed = e.closed ?? CLOSED_BY_DEFAULT.has(e.category)
  const props: Record<string, string> = { ...(e.props ?? {}), category: e.category }
  if (e.typeName) props.typeName = e.typeName
  if (e.category === 'Rooms') {
    props.role = 'room'
    if (e.label) props.label = e.label
  }
  if (e.category === 'Grids' && e.label) props.label = e.label
  if (kind === 'opening' && e.footprint.length) {
    const b = bboxOf(e.footprint)
    props.widthPt = String(Math.round(Math.max(b.maxX - b.minX, b.maxY - b.minY) * 100) / 100)
  }
  const item: ContextItem = {
    id: `${kind}-${e.id}`,
    kind,
    geometry: { points: e.footprint.map((p) => ({ x: p.x, y: p.y })), closed },
    confidence: 1,
    hostRef: e.id,
    props,
  }
  if (e.label !== undefined && (kind === 'label' || kind === 'grid' || e.category === 'Rooms')) item.text = e.label
  return item
}

/** Sheets of a package, in manifest order. */
export function sheetsFromPackage(manifest: DrawingManifest): Sheet[] {
  return manifest.sheets.map((s, i) => {
    const sheet: Sheet = { id: s.id, name: s.name, sizePt: { ...s.sizePt }, pageIndex: i }
    if (s.number !== undefined) sheet.number = s.number
    if (s.scale !== undefined) sheet.scale = s.scale
    return sheet
  })
}

/** Context of one sheet of a package: origin 'package', confidence 1, hostRef set. Defaults to the first sheet. */
export function contextFromPackage(manifest: DrawingManifest, sheetId?: string): SheetContext {
  const sheet = sheetId === undefined ? manifest.sheets[0] : manifest.sheets.find((s) => s.id === sheetId)
  if (!sheet) throw new Error('contextFromPackage: sheet not found')
  const ctx: SheetContext = { sheetId: sheet.id, origin: 'package', items: sheet.elements.map(itemOf) }
  if (sheet.scale !== undefined) ctx.scale = sheet.scale
  return ctx
}
