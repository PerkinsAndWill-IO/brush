import type { ContextItem, ContextItemKind, Sheet, SheetContext } from '../types'
import { bboxOf } from './internal/math'
import type { DrawItem, DrawingElement, DrawingPage } from '../drawing'
import type { DrawingManifest, ManifestElement, ManifestSheet } from './package-format'

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

/** Under everything else when picking: a click inside a room picks the furniture on top, then the room. */
const PICK_ORDER = ['Rooms', 'Casework', 'Furniture', 'Text', 'Walls', 'Windows', 'Doors', 'Grids']
/** Stroke reach of an open footprint, sheet points: how close a pointer must come (the hit test adds its own tolerance). */
const REACH: Record<string, number> = { Walls: 4, Grids: 1, Doors: 3, Windows: 3 }

/**
 * A pickable vector page for one sheet of a JSON package (the Revit link's sheets: a PDF plus a manifest, no vector
 * items). Every element becomes items tied to its id, so the inspector, selection and hover highlights work on it:
 * open footprints a path, closed ones a fill (pick inside) plus their outline. The PDF still draws the sheet; these
 * items are only picked and highlighted. Elements carry what the manifest has: category, type, label and props.
 */
export function vectorPageFromPackage(sheet: ManifestSheet): { page: DrawingPage; elements: Record<string, DrawingElement> } {
  const rank = (c: string) => {
    const i = PICK_ORDER.indexOf(c)
    return i < 0 ? PICK_ORDER.length : i
  }
  const ordered = sheet.elements.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e.category) - rank(b.e.category) || a.i - b.i)
  const items: DrawItem[] = []
  const elements: Record<string, DrawingElement> = {}
  for (const { e } of ordered) {
    if (e.footprint.length === 0) continue
    const xy = new Float32Array(e.footprint.flatMap((p) => [p.x, p.y]))
    const closed = (e.closed ?? CLOSED_BY_DEFAULT.has(e.category)) && e.footprint.length > 2
    if (closed) items.push({ t: 'fill', el: e.id, view: null, rings: [xy], c: [0, 0, 0] })
    items.push({ t: 'path', el: e.id, view: null, xy, closed, w: REACH[e.category] ?? 1, c: [0, 0, 0], dash: [] })
    if (elements[e.id]) continue
    const { level, Level, ...rest } = e.props ?? {}
    const info: DrawingElement = { category: e.category }
    if (e.typeName) info.type = e.typeName
    if (e.label) info.name = e.label
    if (level ?? Level) info.level = level ?? Level
    const params = Object.entries(rest).map(([name, value]) => ({ name, value: String(value) }))
    if (params.length) info.params = params
    elements[e.id] = info
  }
  const page: DrawingPage = {
    id: sheet.id,
    kind: 'sheet',
    number: sheet.number ?? null,
    name: sheet.name,
    scale: sheet.scale ? `1 : ${sheet.scale}` : null,
    sizePt: { ...sheet.sizePt },
    items,
  }
  return { page, elements }
}

/** Context of one sheet of a package: origin 'package', confidence 1, hostRef set. Defaults to the first sheet. */
export function contextFromPackage(manifest: DrawingManifest, sheetId?: string): SheetContext {
  const sheet = sheetId === undefined ? manifest.sheets[0] : manifest.sheets.find((s) => s.id === sheetId)
  if (!sheet) throw new Error('contextFromPackage: sheet not found')
  const ctx: SheetContext = { sheetId: sheet.id, origin: 'package', items: sheet.elements.map(itemOf) }
  if (sheet.scale !== undefined) ctx.scale = sheet.scale
  return ctx
}
