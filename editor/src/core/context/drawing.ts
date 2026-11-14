/**
 * Sheets, context and type palette from a binary `.drawing` document (decision 0008).
 *
 * A `.drawing` carries host-model element metadata (category, type, level, params) and, per page, the 2D items
 * each element was drawn with. This module turns that into the editor's contracts:
 *  - one Sheet per page (sheets first, then views; ids are the host page ids),
 *  - a SheetContext per page with origin 'package', confidence 1 and hostRef = element id,
 *  - a TypePalette of the wall, door and furniture types actually used in the model.
 *
 * Geometry is derived from what was drawn, grouped per (element, view): a wall becomes its centerline with
 * props.thicknessPt (principal axis of its drawn outline), a door or window the opening segment on its host
 * wall's centerline, furniture its oriented box, a grid its line, a room its colour-fill polygon. Plan geometry
 * kinds are only emitted on pages whose title says plan (or says nothing); elsewhere the elements stay
 * `unknown` items so they can still be targeted by id. Pure: no DOM.
 */
import type { ContextItem, ContextItemKind, Point, Sheet, SheetContext } from '../types'
import type { DrawItem, DrawingDocument, DrawingElement, DrawingPage } from '../drawing'
import { DEFAULT_PALETTE } from './palette'
import type { DoorFamilyDef, FurnitureFamilyDef, TypePalette, WallTypeDef } from './package-format'
import { parseScaleText, ptPerMetre } from './scale'
import { allowsPlanGeometry, classifySheet, type SheetType } from './titleblock'
import { polygonArea } from './internal/math'

/** Categories that are sheet furniture or annotation, not model elements: no context item of their own. */
const ANNOTATION = new Set([
  'Title Blocks',
  'Views',
  'Viewports',
  'Schedule Graphics',
  'ColorFillLegend',
  'Elevations',
  'Sections',
  'Callouts',
  'Levels',
  'Dimensions',
  'Matchline',
  'Reference Planes',
  'Scope Boxes',
  'Text Notes',
  'Generic Annotations',
  'Spot Elevations',
  'Room Tags',
  'Door Tags',
  'Window Tags',
  '<Room Separation>',
])
const ANNOTATION_CLASSES = new Set(['IndependentTag', 'RoomTag', 'LinearDimString', 'Dimension', 'TextNote', 'SpotDimension', 'Viewport', 'View'])
const FIXTURES = new Set(['Furniture', 'Furniture Systems', 'Casework', 'Plumbing Fixtures', 'Specialty Equipment'])

/** Category of an element; the class when the exporter had no category. */
export function categoryOf(e: DrawingElement | undefined): string {
  return e?.category ?? e?.class ?? ''
}

function kindOf(category: string): ContextItemKind {
  if (category === 'Walls') return 'wall'
  if (category === 'Doors' || category === 'Windows') return 'opening'
  if (category === 'Grids') return 'grid'
  if (FIXTURES.has(category)) return 'fixture'
  return 'unknown'
}

function isAnnotation(e: DrawingElement | undefined): boolean {
  if (!e) return true
  return ANNOTATION.has(categoryOf(e)) || ANNOTATION_CLASSES.has(e.class ?? '') || (e.tagged !== undefined && e.tagged !== null)
}

// ───────────────────────────── geometry helpers ─────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100

function pointsOf(items: DrawItem[]): Point[] {
  const out: Point[] = []
  const push = (xy: Float32Array) => {
    for (let k = 0; k + 1 < xy.length; k += 2) out.push({ x: xy[k], y: xy[k + 1] })
  }
  for (const it of items) {
    if (it.t === 'path' || it.t === 'segs') push(it.xy)
    else if (it.t === 'fill') it.rings.forEach(push)
    else if (it.t === 'image') {
      const { x, y, w, h } = it.rect
      out.push({ x, y }, { x: x + w, y: y + h })
    }
  }
  return out
}

/** Oriented box from the principal axis of the points: u along, v across. */
export interface OrientedBox {
  c: Point
  u: Point
  v: Point
  minU: number
  maxU: number
  minV: number
  maxV: number
}

export function orientedBox(pts: Point[]): OrientedBox | null {
  if (pts.length === 0) return null
  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const u = { x: Math.cos(a), y: Math.sin(a) }
  const v = { x: -u.y, y: u.x }
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (const p of pts) {
    const du = (p.x - cx) * u.x + (p.y - cy) * u.y
    const dv = (p.x - cx) * v.x + (p.y - cy) * v.y
    minU = Math.min(minU, du)
    maxU = Math.max(maxU, du)
    minV = Math.min(minV, dv)
    maxV = Math.max(maxV, dv)
  }
  return { c: { x: cx, y: cy }, u, v, minU, maxU, minV, maxV }
}

const at = (b: OrientedBox, du: number, dv: number): Point => ({ x: r2(b.c.x + b.u.x * du + b.v.x * dv), y: r2(b.c.y + b.u.y * du + b.v.y * dv) })
const boxPolygon = (b: OrientedBox): Point[] => [at(b, b.minU, b.minV), at(b, b.maxU, b.minV), at(b, b.maxU, b.maxV), at(b, b.minU, b.maxV)]

/** Approximate text box (Arial: cap height 0.716 em, ~0.55 em per glyph), as a polygon in sheet points. */
function textQuad(t: Extract<DrawItem, { t: 'text' }>): Point[] {
  const em = t.size / 0.716
  const lines = t.text.split('\n')
  const width = t.maxWidth ?? Math.max(...lines.map((l) => l.length)) * 0.55 * em
  const height = lines.length * 1.2 * em
  const fx = t.anchor[0] === 'l' ? 0 : t.anchor[0] === 'r' ? 1 : 0.5
  const fy = t.anchor[1] === 't' ? 0 : t.anchor[1] === 'b' ? 1 : 0.5
  const d = t.dir
  const down = { x: -d.y, y: d.x } // perpendicular, pointing down the page for horizontal text
  const o = { x: t.at.x - width * fx * d.x - height * fy * down.x, y: t.at.y - width * fx * d.y - height * fy * down.y }
  const P = (u: number, v: number) => ({ x: r2(o.x + u * d.x + v * down.x), y: r2(o.y + u * d.y + v * down.y) })
  return [P(0, 0), P(width, 0), P(width, height), P(0, height)]
}

function ringArea(xy: Float32Array): number {
  let s = 0
  const n = xy.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    s += xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1]
  }
  return Math.abs(s) / 2
}

// ───────────────────────────── scale ─────────────────────────────

const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000, 1250, 2000, 2500, 5000]

function param(e: DrawingElement | undefined, name: string): string | undefined {
  return e?.params?.find((p) => p.name === name)?.value
}

/**
 * Scale of each view on a page, estimated from walls whose model length is known (`CURVE_ELEM_LENGTH`, mm, as
 * Revit exports it) against their drawn centerline length. The median is snapped to a standard scale within 5%.
 * Views with no such walls are absent.
 */
function estimateViewScales(groups: Group[], elements: Record<string, DrawingElement>): Map<string, number> {
  const ratios = new Map<string, number[]>()
  for (const g of groups) {
    const e = elements[g.el]
    if (categoryOf(e) !== 'Walls') continue
    const mm = parseFloat(param(e, 'CURVE_ELEM_LENGTH') ?? '')
    const b = orientedBox(pointsOf(g.items))
    if (!b || !(mm > 0)) continue
    const lenPt = b.maxU - b.minU
    const thick = b.maxV - b.minV
    if (lenPt < 3 * thick || lenPt < 5) continue // short or square: drawn length is mostly joins
    const s = ((mm / 1000) * ptPerMetre(1)) / lenPt
    const list = ratios.get(g.view) ?? []
    list.push(s)
    ratios.set(g.view, list)
  }
  const out = new Map<string, number>()
  for (const [view, list] of ratios) {
    list.sort((a, b) => a - b)
    const med = list[Math.floor(list.length / 2)]
    const snap = STANDARD_SCALES.find((s) => Math.abs(s - med) / s <= 0.05)
    if (snap) out.set(view, snap)
  }
  return out
}

// ───────────────────────────── per page ─────────────────────────────

interface Group {
  el: string
  /** View id, '' when the items carry none. */
  view: string
  items: DrawItem[]
}

function groupsOf(page: DrawingPage): Group[] {
  const map = new Map<string, Group>()
  for (const it of page.items) {
    if (it.el === null || it.t === 'text') continue
    const view = it.view ?? ''
    const key = `${it.el}|${view}`
    let g = map.get(key)
    if (!g) map.set(key, (g = { el: it.el, view, items: [] }))
    g.items.push(it)
  }
  return [...map.values()]
}

/** Sheet type of a page from its number and name (the title-block words the PDF path reads). */
export function drawingPageType(page: DrawingPage): SheetType {
  if (page.kind === 'view' && /\{?3D\}?|axonom|isometr|perspect/i.test(page.name)) return 'axonometric'
  return classifySheet({ number: page.number ?? undefined, name: page.name }).sheetType
}

interface PageAnalysis {
  ctx: SheetContext
  /** Scale per view id (stated or estimated). */
  viewScales: Map<string, number>
  /** Scale of the page as a whole (stated, else the scale of the view with the most plan elements). */
  scale?: number
}

const cache = new WeakMap<DrawingPage, PageAnalysis>()

function analyse(doc: DrawingDocument, page: DrawingPage): PageAnalysis {
  const hit = cache.get(page)
  if (hit) return hit
  const { elements } = doc
  const groups = groupsOf(page)
  const sheetType = drawingPageType(page)
  const planOk = allowsPlanGeometry(sheetType)
  const stated = page.scale ? parseScaleText(page.scale) : undefined
  const viewScales = estimateViewScales(groups, elements)
  if (stated) for (const g of groups) viewScales.set(g.view, stated)
  let scale = stated
  if (!scale) {
    const votes = new Map<number, number>()
    for (const g of groups) {
      const s = viewScales.get(g.view)
      if (s && kindOf(categoryOf(elements[g.el])) !== 'unknown') votes.set(s, (votes.get(s) ?? 0) + 1)
    }
    scale = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
  }

  // element ids that appear in more than one view on this page get a view suffix on their item ids
  const views = new Map<string, number>()
  for (const g of groups) views.set(g.el, (views.get(g.el) ?? 0) + 1)
  const itemId = (kind: string, g: Group) => (views.get(g.el)! > 1 ? `${kind}-${g.el}@${g.view}` : `${kind}-${g.el}`)

  const items: ContextItem[] = []
  const walls: Array<{ item: ContextItem; view: string; a: Point; b: Point; thick: number }> = []
  const openings: Group[] = []

  for (const g of groups) {
    const e = elements[g.el]
    if (isAnnotation(e)) continue
    const category = categoryOf(e)
    let kind = kindOf(category)
    if (!planOk && kind !== 'grid') kind = 'unknown'
    const props: Record<string, string> = { category }
    if (e?.type) props.typeName = e.type
    if (e?.family) props.family = e.family
    if (e?.level) props.level = e.level
    if (g.view) props.view = g.view
    const pts = pointsOf(g.items)
    const box = orientedBox(pts)
    if (!box) continue
    const base = { confidence: 1, hostRef: g.el, props }

    if (kind === 'wall') {
      const len = box.maxU - box.minU
      const thick = box.maxV - box.minV
      if (r2(thick) > 0 && len >= 1.5 * thick) {
        const mid = (box.minV + box.maxV) / 2
        const a = at(box, box.minU, mid)
        const b = at(box, box.maxU, mid)
        props.thicknessPt = String(r2(thick))
        const item: ContextItem = { id: itemId('wall', g), kind: 'wall', geometry: { points: [a, b], closed: false }, ...base }
        items.push(item)
        walls.push({ item, view: g.view, a, b, thick })
        continue
      }
      kind = 'unknown' // a stub or junction piece: keep it targetable, but it is no wall line
    }
    if (kind === 'opening') {
      openings.push(g)
      continue
    }
    if (kind === 'grid') {
      const mid = (box.minV + box.maxV) / 2
      if (e?.name) props.label = e.name
      const item: ContextItem = { id: itemId('grid', g), kind: 'grid', geometry: { points: [at(box, box.minU, mid), at(box, box.maxU, mid)], closed: false }, ...base }
      if (e?.name) item.text = e.name
      items.push(item)
      continue
    }
    if (category === 'Rooms' && planOk) {
      let best: Float32Array | undefined
      for (const it of g.items) if (it.t === 'fill') for (const r of it.rings) if (!best || ringArea(r) > ringArea(best)) best = r
      const poly: Point[] = []
      if (best) for (let k = 0; k + 1 < best.length; k += 2) poly.push({ x: r2(best[k]), y: r2(best[k + 1]) })
      const polygon = poly.length >= 3 ? poly : boxPolygon(box)
      props.role = 'room'
      if (e?.name) props.label = e.name
      props.areaPt2 = String(r2(polygonArea(polygon)))
      const item: ContextItem = { id: itemId('room', g), kind: 'unknown', geometry: { points: polygon, closed: true }, ...base }
      if (e?.name) item.text = e.name
      items.push(item)
      continue
    }
    if (kind === 'fixture') {
      props.widthPt = String(r2(box.maxU - box.minU))
      props.depthPt = String(r2(box.maxV - box.minV))
    }
    items.push({ id: itemId(kind, g), kind, geometry: { points: boxPolygon(box), closed: true }, ...base })
  }

  // doors and windows: the opening segment on the host wall's centerline (else the long side of their box)
  for (const g of openings) {
    const e = elements[g.el]
    const pts = pointsOf(g.items)
    const box = orientedBox(pts)!
    const props: Record<string, string> = { category: categoryOf(e) }
    if (e?.type) props.typeName = e.type
    if (e?.family) props.family = e.family
    if (e?.level) props.level = e.level
    if (g.view) props.view = g.view
    let best: { w: (typeof walls)[number]; lo: number; hi: number; n: number } | undefined
    for (const w of walls) {
      if (w.view !== g.view) continue
      const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
      if (L < 1e-6) continue
      const ux = (w.b.x - w.a.x) / L
      const uy = (w.b.y - w.a.y) / L
      const band = w.thick / 2 + Math.max(1, 0.25 * w.thick)
      let lo = Infinity
      let hi = -Infinity
      let n = 0
      for (const p of pts) {
        const along = (p.x - w.a.x) * ux + (p.y - w.a.y) * uy
        const off = Math.abs((p.x - w.a.x) * -uy + (p.y - w.a.y) * ux)
        if (off <= band && along >= -w.thick && along <= L + w.thick) {
          n++
          lo = Math.min(lo, along)
          hi = Math.max(hi, along)
        }
      }
      if (n >= 2 && hi - lo > 1 && (!best || n > best.n)) best = { w, lo, hi, n }
    }
    let seg: [Point, Point]
    if (best) {
      const { a, b } = best.w
      const L = Math.hypot(b.x - a.x, b.y - a.y)
      const P = (s: number) => ({ x: r2(a.x + ((b.x - a.x) * s) / L), y: r2(a.y + ((b.y - a.y) * s) / L) })
      seg = [P(Math.max(0, best.lo)), P(Math.min(L, best.hi))]
      props.hostWall = best.w.item.hostRef!
    } else {
      const mid = (box.minV + box.maxV) / 2
      seg = [at(box, box.minU, mid), at(box, box.maxU, mid)]
    }
    props.widthPt = String(r2(Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y)))
    items.push({ id: itemId('opening', g), kind: 'opening', geometry: { points: seg, closed: false }, confidence: 1, hostRef: g.el, props })
  }

  // every text is a label; tags point at the element they label
  page.items.forEach((t, i) => {
    if (t.t !== 'text' || !t.text.trim()) return
    const e = t.el !== null ? elements[t.el] : undefined
    const category = categoryOf(e)
    const props: Record<string, string> = { role: labelRole(e, category) }
    if (category) props.category = category
    if (e?.tagged !== undefined && e.tagged !== null) props.tagged = String(e.tagged)
    const item: ContextItem = { id: `label-${i}`, kind: 'label', geometry: { points: textQuad(t), closed: true }, text: t.text, confidence: 1, props }
    if (t.el !== null) item.hostRef = t.el
    items.push(item)
  })

  // sheet facts (what sheetInfo() reads), parked at the bottom-right corner like the inferred ones
  const { w, h } = page.sizePt
  const info: Record<string, string> = { role: 'sheet-info', sheetType, sheetTypeBy: 'title' }
  if (page.number) info.number = page.number
  if (page.name) info.title = page.name
  items.push({
    id: 'sheet-info',
    kind: 'unknown',
    geometry: { points: [{ x: w - 1, y: h - 1 }, { x: w, y: h - 1 }, { x: w, y: h }, { x: w - 1, y: h }], closed: true },
    confidence: 1,
    props: info,
  })

  const ctx: SheetContext = { sheetId: page.id, origin: 'package', items }
  if (scale) ctx.scale = scale
  const res: PageAnalysis = { ctx, viewScales, scale }
  cache.set(page, res)
  return res
}

function labelRole(e: DrawingElement | undefined, category: string): string {
  if (!e) return 'text'
  if (category === 'Title Blocks') return 'titleblock'
  if (category === 'Grids') return 'grid'
  if (category === 'Rooms' || e.class === 'RoomTag') return 'room'
  if (e.class === 'LinearDimString' || category === 'Dimensions') return 'dimension'
  if (e.tagged !== undefined && e.tagged !== null) return 'tag'
  return 'text'
}

// ───────────────────────────── public API ─────────────────────────────

/** Sheets of a `.drawing`, in the viewer's order (sheets, then views). Ids are the host page ids. */
export function sheetsFromDrawing(doc: DrawingDocument): Sheet[] {
  return doc.pages.map((p, i) => {
    const sheet: Sheet = { id: p.id, name: p.name || (p.kind === 'view' ? `View ${p.id}` : `Sheet ${p.id}`), sizePt: { ...p.sizePt }, pageIndex: i }
    if (p.number) sheet.number = p.number
    const scale = analyse(doc, p).scale
    if (scale) sheet.scale = scale
    return sheet
  })
}

/** Context of one page: origin 'package', confidence 1, hostRef = element id. Defaults to the first page. */
export function contextFromDrawing(doc: DrawingDocument, sheetId?: string): SheetContext {
  const page = sheetId === undefined ? doc.pages[0] : doc.pages.find((p) => p.id === sheetId)
  if (!page) throw new Error('contextFromDrawing: sheet not found')
  return analyse(doc, page).ctx
}

const round5 = (mm: number) => Math.round(mm / 5) * 5
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

/**
 * The host model's own types, measured from plan pages: wall types with their drawn thickness, door families
 * with their width (from the type name "800 x 2100" when it says, else measured), furniture with its box.
 * Types on views of unknown scale cannot be measured and are left out; an empty list falls back to the default.
 */
export function paletteFromDrawing(doc: DrawingDocument): TypePalette {
  const walls = new Map<string, number[]>()
  const doors = new Map<string, { w: number[]; h?: number }>()
  const furniture = new Map<string, { w: number[]; d: number[] }>()
  for (const page of doc.pages) {
    const { ctx, viewScales, scale } = analyse(doc, page)
    for (const it of ctx.items) {
      const p = it.props ?? {}
      const s = viewScales.get(p.view ?? '') ?? scale
      if (!s || !p.typeName) continue
      const mm = (pt: string | undefined) => (Number(pt) / ptPerMetre(s)) * 1000
      if (it.kind === 'wall' && p.thicknessPt) {
        const list = walls.get(p.typeName) ?? []
        list.push(mm(p.thicknessPt))
        walls.set(p.typeName, list)
      } else if (it.kind === 'opening' && p.category === 'Doors' && p.widthPt) {
        const name = p.family && !p.typeName.startsWith(p.family) ? `${p.family} ${p.typeName}` : p.typeName
        const m = /(\d{3,4})\s*[x×]\s*(\d{3,4})/i.exec(p.typeName)
        const d = doors.get(name) ?? { w: [] }
        d.w.push(m ? Number(m[1]) : mm(p.widthPt))
        if (m) d.h = Number(m[2])
        doors.set(name, d)
      } else if (it.kind === 'fixture' && p.category === 'Furniture' && p.widthPt && p.depthPt) {
        const f = furniture.get(p.typeName) ?? { w: [], d: [] }
        f.w.push(mm(p.widthPt))
        f.d.push(mm(p.depthPt))
        furniture.set(p.typeName, f)
      }
    }
  }
  const wallDefs: WallTypeDef[] = [...walls].map(([name, t]) => ({ name, thicknessMm: round5(median(t)) })).filter((w) => w.thicknessMm > 0)
  const doorDefs: DoorFamilyDef[] = [...doors].map(([name, d]) => {
    const def: DoorFamilyDef = { name, widthMm: round5(median(d.w)) }
    if (d.h) def.heightMm = d.h
    return def
  })
  const furnDefs: FurnitureFamilyDef[] = [...furniture].map(([name, f]) => ({ name, widthMm: round5(median(f.w)), depthMm: round5(median(f.d)) }))
  return {
    walls: wallDefs.length ? wallDefs : DEFAULT_PALETTE.walls,
    doors: doorDefs.length ? doorDefs : DEFAULT_PALETTE.doors,
    furniture: furnDefs.length ? furnDefs : DEFAULT_PALETTE.furniture,
  }
}

// ───────────────────────────── furniture symbols ─────────────────────────────

/** One line of a symbol, in the symbol's unit frame: u across its width, v across its depth, both -0.5..0.5. */
export interface SymbolLine {
  pts: Point[]
  closed: boolean
}

/** How a furniture type is drawn on plan, taken from one placed instance, normalised to its box. */
export interface FurnitureSymbol {
  /** Box of the instance it was taken from, sheet points (width along u). */
  widthPt: number
  depthPt: number
  lines: SymbolLine[]
}

/**
 * Plan symbol of each furniture type in the document, from the first plan instance of it that draws any lines.
 * The frame is the one the context item's box uses (principal axis), except for near-square pieces, whose principal
 * axis is noise: those use the sheet axes, which is how they are almost always placed.
 */
export function furnitureSymbolsFromDrawing(doc: DrawingDocument): Map<string, FurnitureSymbol> {
  const out = new Map<string, FurnitureSymbol>()
  for (const page of doc.pages) {
    const { ctx } = analyse(doc, page)
    const wanted = new Map<string, string>() // `${el}|${view}` -> typeName
    for (const it of ctx.items) {
      const p = it.props
      if (it.kind !== 'fixture' || p?.category !== 'Furniture' || !p.typeName || out.has(p.typeName) || !it.hostRef) continue
      wanted.set(`${it.hostRef}|${p.view ?? ''}`, p.typeName)
    }
    if (!wanted.size) continue
    for (const g of groupsOf(page)) {
      const type = wanted.get(`${g.el}|${g.view}`)
      if (!type || out.has(type)) continue
      const sym = symbolOf(g.items)
      if (sym) out.set(type, sym)
    }
  }
  return out
}

function symbolOf(items: DrawItem[]): FurnitureSymbol | null {
  const pb = orientedBox(pointsOf(items))
  if (!pb) return null
  let b = pb
  if (Math.max(pb.maxU - pb.minU, pb.maxV - pb.minV) <= 1.15 * Math.min(pb.maxU - pb.minU, pb.maxV - pb.minV)) {
    // axis-aligned box around the same points
    const pts = pointsOf(items)
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }
    b = { c, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, minU: x0 - c.x, maxU: x1 - c.x, minV: y0 - c.y, maxV: y1 - c.y }
  }
  const w = b.maxU - b.minU
  const d = b.maxV - b.minV
  if (!(w > 0) || !(d > 0)) return null
  const mu = (b.minU + b.maxU) / 2
  const mv = (b.minV + b.maxV) / 2
  const local = (x: number, y: number): Point => {
    const dx = x - b.c.x
    const dy = y - b.c.y
    return { x: r4(((dx * b.u.x + dy * b.u.y) - mu) / w), y: r4(((dx * b.v.x + dy * b.v.y) - mv) / d) }
  }
  const lines: SymbolLine[] = []
  for (const it of items) {
    if (it.t === 'path') {
      const pts: Point[] = []
      for (let k = 0; k + 1 < it.xy.length; k += 2) pts.push(local(it.xy[k], it.xy[k + 1]))
      if (pts.length >= 2) lines.push({ pts, closed: it.closed })
    } else if (it.t === 'segs') {
      for (let k = 0; k + 3 < it.xy.length; k += 4) lines.push({ pts: [local(it.xy[k], it.xy[k + 1]), local(it.xy[k + 2], it.xy[k + 3])], closed: false })
    } else if (it.t === 'fill') {
      for (const ring of it.rings) {
        const pts: Point[] = []
        for (let k = 0; k + 1 < ring.length; k += 2) pts.push(local(ring[k], ring[k + 1]))
        if (pts.length >= 3) lines.push({ pts, closed: true })
      }
    }
  }
  return lines.length ? { widthPt: r2(w), depthPt: r2(d), lines } : null
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4

// ───────────────────────────── wall styles ─────────────────────────────

/** One line that runs along a wall: its offset across the wall (faces at -0.5 and 0.5) and its stroke weight (pt). */
export interface WallStyleLine {
  offset: number
  weightPt: number
}

/** A band of solid fill along a wall (a layer's background or poché), across offsets `from..to` (-0.5..0.5). */
export interface WallStyleFill {
  from: number
  to: number
  /** RGB 0..255, as drawn. */
  color: [number, number, number]
}

/** How a wall type is drawn on plan, taken from one placed instance, normalised to its face-to-face thickness. */
export interface WallStyle {
  /** Face-to-face thickness of the instance it was taken from, sheet points. */
  thicknessPt: number
  /** The same in model millimetres, when the view's scale is known. */
  thicknessMm?: number
  /** Lines parallel to the wall: the two faces (heaviest), layer boundaries, the location line. Sorted by offset. */
  lines: WallStyleLine[]
  /** Fills between the faces, sorted by `from`. */
  fills: WallStyleFill[]
}

/**
 * Plan linework of each wall type in the document, from its longest straight instance on a plan page: the lines
 * that run the instance's length parallel to it (faces, layer boundaries, location line) as offsets across it, and
 * its fill bands. Short pieces (hatch strokes, join clean-ups, end caps) are left out. Pure.
 */
export function wallStylesFromDrawing(doc: DrawingDocument): Map<string, WallStyle> {
  // every instance of each type is a candidate; the one whose linework reads best wins
  const best = new Map<string, { style: WallStyle; score: number }>()
  for (const page of doc.pages) {
    const { ctx, viewScales, scale } = analyse(doc, page)
    let groups: Map<string, Group> | undefined
    for (const it of ctx.items) {
      const p = it.props
      if (it.kind !== 'wall' || !p?.typeName || !it.hostRef || it.geometry.points.length < 2) continue
      groups ??= new Map(groupsOf(page).map((g) => [`${g.el}|${g.view}`, g]))
      const g = groups.get(`${it.hostRef}|${p.view ?? ''}`)
      const style = g && wallStyleOf(g.items, it.geometry.points[0], it.geometry.points[1])
      if (!style) continue
      const s = viewScales.get(p.view ?? '') ?? scale
      if (s) style.thicknessMm = r2((style.thicknessPt / ptPerMetre(s)) * 1000)
      // faces that agree with the drawn outline, then the most layers, then the longest run
      const boxT = Number(p.thicknessPt)
      const fit = boxT > 0 ? Math.abs(style.thicknessPt - boxT) / boxT : 0
      const [a, b] = it.geometry.points
      const score = (fit <= 0.15 ? 1000 : -1000 * fit) + 10 * (style.lines.length + style.fills.length) + Math.min(9, Math.hypot(b.x - a.x, b.y - a.y) / 100)
      const cur = best.get(p.typeName)
      if (!cur || score > cur.score) best.set(p.typeName, { style, score })
    }
  }
  return new Map([...best].map(([k, v]) => [k, v.style]))
}

function wallStyleOf(items: DrawItem[], a: Point, b: Point): WallStyle | null {
  const L = Math.hypot(b.x - a.x, b.y - a.y)
  if (!(L > 0)) return null
  const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }
  const v = { x: -u.y, y: u.x }
  const along = (p: Point) => (p.x - a.x) * u.x + (p.y - a.y) * u.y
  const across = (p: Point) => (p.x - a.x) * v.x + (p.y - a.y) * v.y
  const TOL = 0.04 // pt: offsets closer than this are the same line
  const key = (o: number) => Math.round(o / TOL)

  // parallel pieces: total length per (offset, weight)
  const runs = new Map<string, { off: number; w: number; len: number }>()
  const piece = (p: Point, q: Point, w: number) => {
    const dl = Math.abs(along(q) - along(p))
    const dv = Math.abs(across(q) - across(p))
    if (dl < 1e-6 || dv > 0.02 * dl + 0.02) return // not parallel to the wall
    const off = (across(p) + across(q)) / 2
    const k = `${key(off)}|${w}`
    const r = runs.get(k) ?? { off, w, len: 0 }
    r.len += dl
    runs.set(k, r)
  }
  for (const it of items) {
    if (it.t === 'segs') for (let k = 0; k + 3 < it.xy.length; k += 4) piece({ x: it.xy[k], y: it.xy[k + 1] }, { x: it.xy[k + 2], y: it.xy[k + 3] }, it.w)
    else if (it.t === 'path') {
      const n = it.xy.length / 2
      for (let k = 0; k + 1 < n; k++) piece({ x: it.xy[2 * k], y: it.xy[2 * k + 1] }, { x: it.xy[2 * k + 2], y: it.xy[2 * k + 3] }, it.w)
    }
  }
  // a line of the type runs (most of) the wall's length; short ones are joins, caps or hatching
  const kept = [...runs.values()].filter((r) => r.len >= 0.3 * L)
  if (!kept.length) return null
  // faces: the outermost of the heaviest lines (else the outermost lines)
  const heavy = Math.max(...kept.map((r) => r.w))
  const faces = kept.filter((r) => r.w >= 0.99 * heavy)
  const src = faces.length >= 2 ? faces : kept
  const lo = Math.min(...src.map((r) => r.off))
  const hi = Math.max(...src.map((r) => r.off))
  const T = hi - lo
  if (!(T > 0.2)) return null
  const mid = (lo + hi) / 2
  const norm = (o: number) => r4((o - mid) / T)

  // one line per offset (the heaviest weight drawn there), inside the faces
  const byOff = new Map<number, WallStyleLine>()
  for (const r of kept) {
    const o = norm(r.off)
    if (Math.abs(o) > 0.5 + TOL / T) continue
    const k = key(r.off)
    const cur = byOff.get(k)
    if (!cur || r.w > cur.weightPt) byOff.set(k, { offset: Math.max(-0.5, Math.min(0.5, o)), weightPt: r4(r.w) })
  }
  // lines a hair apart (a layer edge drawn twice, a face and its fill edge) read as one: keep the heavier
  const lines: WallStyleLine[] = []
  for (const l of [...byOff.values()].sort((p, q) => p.offset - q.offset)) {
    const prev = lines[lines.length - 1]
    if (prev && (l.offset - prev.offset) * T < 0.12) {
      if (l.weightPt > prev.weightPt || (l.weightPt === prev.weightPt && Math.abs(l.offset) > Math.abs(prev.offset))) lines[lines.length - 1] = l
    } else lines.push(l)
  }

  // fills: each ring's extent across the wall, kept when it runs a good part of the length
  const fills: WallStyleFill[] = []
  for (const it of items) {
    if (it.t !== 'fill') continue
    let fLo = Infinity
    let fHi = -Infinity
    let len = 0
    for (const ring of it.rings) {
      let rLo = Infinity
      let rHi = -Infinity
      let aLo = Infinity
      let aHi = -Infinity
      for (let k = 0; k + 1 < ring.length; k += 2) {
        const p = { x: ring[k], y: ring[k + 1] }
        rLo = Math.min(rLo, across(p))
        rHi = Math.max(rHi, across(p))
        aLo = Math.min(aLo, along(p))
        aHi = Math.max(aHi, along(p))
      }
      if (rHi - rLo > T * 1.2) continue // not a band of this wall
      fLo = Math.min(fLo, rLo)
      fHi = Math.max(fHi, rHi)
      len += aHi - aLo
    }
    if (len < 0.3 * L || !(fHi > fLo)) continue
    const from = Math.max(-0.5, norm(fLo))
    const to = Math.min(0.5, norm(fHi))
    if (to - from < 1e-3) continue
    fills.push({ from, to, color: [it.c[0], it.c[1], it.c[2]] })
  }
  fills.sort((p, q) => p.from - q.from)
  return { thicknessPt: r2(T), lines, fills }
}
