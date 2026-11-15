/**
 * Type menu (docs/tasks/S1-select-and-retype.md), the pure part: what can be selected on the board, which types an
 * element can take, a drawn element given another type, and the hit test for drawn elements. No DOM, no stores.
 */
import type { AcceptedDecision, Command, DecisionKind, Path, Point, Stroke } from '@core/types'
import type { DrawingElement } from '@core/drawing'
import { categoryOf, type TypePalette } from '@core/context'
import { closestPointOnPolyline } from '@core/geometry'

/** One selected thing: an element drawn this session (by its stroke) or a host element on a `.drawing` sheet. */
export type SelItem = { t: 'drawn'; strokeId: string } | { t: 'sheet'; id: string }

export const selKey = (s: SelItem): string => (s.t === 'drawn' ? `d:${s.strokeId}` : `s:${s.id}`)
export const sameSel = (a: SelItem, b: SelItem): boolean => selKey(a) === selKey(b)

/** A type an element can take. `label` is what the menu shows and how types are matched across sources. */
export interface TypeOption {
  label: string
  typeName: string
  family?: string
}

/** Kinds a drawn element can be read as from the menu (delete is the eraser's, not a type). */
export const READ_AS: readonly DecisionKind[] = ['wall', 'door', 'furniture', 'markup']

/** Host category of each drawn kind that has types. */
export const CATEGORY_OF_KIND: Partial<Record<DecisionKind, string>> = { wall: 'Walls', door: 'Doors', furniture: 'Furniture' }

/** A type's label, by the rule paletteFromDrawing names door families: "Family Type" unless the type already says it. */
export function typeLabel(family: string | null | undefined, type: string): string {
  return family && !type.startsWith(family) ? `${family} ${type}` : type
}

/** Types the palette offers for a drawn kind (none for markup / delete). */
export function paletteOptions(palette: TypePalette, kind: DecisionKind): TypeOption[] {
  const list = kind === 'wall' ? palette.walls : kind === 'door' ? palette.doors : kind === 'furniture' ? palette.furniture : []
  return list.map((t) => ({ label: t.name, typeName: t.name }))
}

/** The type of a host element now: the pending `set_type` for it if there is one, else its own. */
export function sheetElementType(id: string, el: DrawingElement | undefined, commands: readonly Command[]): TypeOption | null {
  const cmd = setTypeFor(commands, id)
  if (cmd) return { label: typeLabel(cmd.family, cmd.typeName), typeName: cmd.typeName, family: cmd.family }
  if (!el?.type) return null
  const o: TypeOption = { label: typeLabel(el.family, el.type), typeName: el.type }
  if (el.family) o.family = el.family
  return o
}

/** The element's own type, as the drawing has it (ignoring pending changes). */
export function originalType(el: DrawingElement | undefined): TypeOption | null {
  return sheetElementType('', el, [])
}

export type SetTypeCommand = Extract<Command, { op: 'set_type' }>

/** The pending `set_type` for host element `id`, if any. */
export function setTypeFor(commands: readonly Command[], id: string): SetTypeCommand | undefined {
  for (let i = commands.length - 1; i >= 0; i--) {
    const c = commands[i]
    if (c.op === 'set_type' && c.targets.includes(id)) return c
  }
  return undefined
}

/**
 * Every type of `category` used by the elements of the open document, sorted by label. Element maps are walked once
 * each even when several sheets share one (a `.drawing` hands every page the same map).
 */
export function documentTypes(elementMaps: readonly Record<string, DrawingElement>[], category: string): TypeOption[] {
  const out = new Map<string, TypeOption>()
  const seen = new Set<Record<string, DrawingElement>>()
  for (const m of elementMaps) {
    if (seen.has(m)) continue
    seen.add(m)
    for (const el of Object.values(m)) {
      if (!el.type || categoryOf(el) !== category || el.tagged != null) continue
      const label = typeLabel(el.family, el.type)
      if (!out.has(label)) out.set(label, el.family ? { label, typeName: el.type, family: el.family } : { label, typeName: el.type })
    }
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
}

/** Options merged by label, first list first (a palette type and the same type found in the document are one row). */
export function mergeOptions(...lists: TypeOption[][]): TypeOption[] {
  const out = new Map<string, TypeOption>()
  for (const l of lists) for (const o of l) if (!out.has(o.label)) out.set(o.label, o)
  return [...out.values()]
}

// ───────────── a drawn element given another type ─────────────

const unit = (a: Point, b: Point): Point => {
  const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

/**
 * `d` with type `typeName`. A door or a furniture piece takes the new type's size about its centre when the sheet
 * scale is known (`ptPerM`) and the palette knows the type, as the brush sizes them; a wall keeps its centre line
 * (its drawn thickness follows the type).
 */
export function withType(d: AcceptedDecision, typeName: string, palette: TypePalette, ptPerM?: number): AcceptedDecision {
  const out: AcceptedDecision = { ...d, type: typeName, geometry: { points: d.geometry.points.map((p) => ({ ...p })), closed: d.geometry.closed } }
  const pts = out.geometry.points
  if (!ptPerM || !(ptPerM > 0)) return out
  if (d.kind === 'door' && d.geometry.closed && pts.length >= 4) {
    // elevation door face on (E1-04): bottom-left, bottom-right, top-right, top-left; keep the sill's centre
    const fam = palette.doors.find((f) => f.name === typeName)
    if (!fam) return out
    const [bl, br, , tl] = pts
    const m = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 }
    const u = unit(bl, br)
    const v = unit(bl, tl)
    const w = ((fam.widthMm / 1000) * ptPerM) / 2
    const h = fam.heightMm !== undefined ? (fam.heightMm / 1000) * ptPerM : Math.hypot(tl.x - bl.x, tl.y - bl.y)
    const at = (sx: number, up: number): Point => ({ x: m.x + u.x * w * sx + v.x * h * up, y: m.y + u.y * w * sx + v.y * h * up })
    out.geometry = { points: [at(-1, 0), at(1, 0), at(1, 1), at(-1, 1)], closed: true }
  } else if (d.kind === 'door' && pts.length >= 2) {
    const fam = palette.doors.find((f) => f.name === typeName)
    if (!fam) return out
    const a = pts[0]
    const b = pts[pts.length - 1]
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const u = unit(a, b)
    const h = ((fam.widthMm / 1000) * ptPerM) / 2
    out.geometry = { points: [{ x: m.x - u.x * h, y: m.y - u.y * h }, { x: m.x + u.x * h, y: m.y + u.y * h }], closed: false }
  } else if (d.kind === 'furniture' && pts.length === 4) {
    const fam = palette.furniture.find((f) => f.name === typeName)
    if (!fam) return out
    const c = { x: (pts[0].x + pts[2].x) / 2, y: (pts[0].y + pts[2].y) / 2 }
    const u = unit(pts[0], pts[1]) // the family's width runs along the first side
    const v = unit(pts[0], pts[3])
    const w = ((fam.widthMm / 1000) * ptPerM) / 2
    const h = ((fam.depthMm / 1000) * ptPerM) / 2
    const at = (sx: number, sy: number): Point => ({ x: c.x + u.x * w * sx + v.x * h * sy, y: c.y + u.y * w * sx + v.y * h * sy })
    out.geometry = { points: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], closed: true }
  }
  return out
}

// ───────────── hit test for drawn elements ─────────────

function inside(p: Point, poly: readonly Point[]): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

/** Distance from `p` to a path; 0 inside a closed one. */
function distTo(p: Point, path: Path): number {
  if (!path.points.length) return Infinity
  if (path.closed && path.points.length > 2 && inside(p, path.points)) return 0
  return closestPointOnPolyline(p, path.points, path.closed).distance
}

export interface DrawnHitInput {
  sheetId: string
  accepted: readonly AcceptedDecision[]
  strokes: readonly Stroke[]
  /** Strokes not on the board (landed in the linked model). */
  hidden: ReadonlySet<string>
  /** Half the drawn thickness of a wall decision, in sheet points. */
  wallHalf: (d: AcceptedDecision) => number
}

/**
 * The drawn element nearest `p` (sheet points) within `tol`: an element's own geometry (a wall's body, a door's
 * opening, inside a furniture box), or the ink of any brush stroke (an element's faded ink, or plain markup).
 * Returns the stroke id, or null. Deletes and eraser passes are not selectable.
 */
export function drawnAt(p: Point, tol: number, input: DrawnHitInput): string | null {
  let best: string | null = null
  let bd = Infinity
  for (const d of input.accepted) {
    if (d.sheetId !== input.sheetId || d.kind === 'delete' || input.hidden.has(d.strokeId)) continue
    const extra = d.kind === 'wall' ? input.wallHalf(d) : 0
    const dist = Math.max(0, distTo(p, d.geometry) - extra)
    if (dist <= tol && dist < bd) {
      bd = dist
      best = d.strokeId
    }
  }
  const deletes = new Set(input.accepted.filter((d) => d.kind === 'delete').map((d) => d.strokeId))
  for (const s of input.strokes) {
    if (s.sheetId !== input.sheetId || s.tool !== 'brush' || input.hidden.has(s.id) || deletes.has(s.id) || !s.points.length) continue
    const dist = Math.max(0, closestPointOnPolyline(p, s.points).distance - s.size / 2)
    if (dist <= tol && dist < bd) {
      bd = dist
      best = s.id
    }
  }
  return best
}
