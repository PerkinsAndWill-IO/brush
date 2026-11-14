import type { Path, Point, SheetContext } from '../types'
import { bboxOf, distToPolygon, hyp, pointInPolygon, polygonArea, signedArea, simplifyRing } from './internal/math'

export interface RoomResult {
  label?: string
  polygon?: Path
  areaM2?: number
  /** Context item id of the room, when one exists. */
  itemId?: string
}

export interface RoomAtOptions {
  /** If the point is not inside a room, accept the nearest room within this distance (default 8 pt). */
  tolerancePt?: number
}

const PT_MM = 25.4 / 72

export function areaToM2(areaPt2: number, scale?: number): number | undefined {
  if (!scale) return undefined
  const k = (PT_MM * scale) / 1000
  return areaPt2 * k * k
}

/**
 * Room containing (or nearest to) a point. Works for both inferred contexts (rooms built from
 * walls) and package contexts (Rooms elements): both are `unknown` items with props.role === 'room'.
 */
export function roomAt(ctx: SheetContext, point: Point, opts: RoomAtOptions = {}): RoomResult {
  const tol = opts.tolerancePt ?? 8
  let best: { id: string; poly: Point[]; label?: string; area: number; d: number } | undefined
  for (const it of ctx.items) {
    if (it.kind !== 'unknown' || it.props?.role !== 'room' || it.geometry.points.length < 3) continue
    const pts = it.geometry.points
    const bb = bboxOf(pts)
    if (point.x < bb.minX - tol || point.x > bb.maxX + tol || point.y < bb.minY - tol || point.y > bb.maxY + tol) continue
    const inside = pointInPolygon(point.x, point.y, pts)
    const d = inside ? 0 : distToPolygon(point.x, point.y, pts)
    if (d > tol) continue
    const area = polygonArea(pts)
    if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && area < best.area)) {
      best = { id: it.id, poly: pts, label: it.props?.label ?? it.text, area, d }
    }
  }
  if (!best) return {}
  const res: RoomResult = { polygon: { points: best.poly, closed: true }, itemId: best.id }
  if (best.label) res.label = best.label
  const a = areaToM2(best.area, ctx.scale)
  if (a !== undefined) res.areaM2 = a
  return res
}

export interface RoomRegion {
  polygon: Point[]
  areaPt2: number
}

export interface WallStamp {
  ax: number
  ay: number
  bx: number
  by: number
  thick: number
}

/**
 * Closed regions bounded by the stamped walls (raster flood fill on a coarse grid, deterministic).
 * Regions touching the outside, or larger than `maxAreaFrac` of the page, are discarded.
 */
export function buildRooms(
  W: number,
  H: number,
  walls: WallStamp[],
  cell: number,
  minAreaPt2: number,
  maxAreaFrac = 0.5,
): RoomRegion[] {
  if (!walls.length) return []
  const gw = Math.ceil(W / cell) + 4
  const gh = Math.ceil(H / cell) + 4
  const off = 2 // padding cells
  const blocked = new Uint8Array(gw * gh)
  const stampDisc = (x: number, y: number, rad: number) => {
    const cx = Math.floor(x / cell) + off
    const cy = Math.floor(y / cell) + off
    const R = Math.ceil(rad / cell)
    for (let yy = cy - R; yy <= cy + R; yy++) {
      if (yy < 0 || yy >= gh) continue
      for (let xx = cx - R; xx <= cx + R; xx++) {
        if (xx < 0 || xx >= gw) continue
        const px = (xx - off + 0.5) * cell
        const py = (yy - off + 0.5) * cell
        if (hyp(px - x, py - y) <= rad) blocked[yy * gw + xx] = 1
      }
    }
  }
  for (const w of walls) {
    const dx = w.bx - w.ax
    const dy = w.by - w.ay
    const len = hyp(dx, dy)
    const rad = w.thick / 2 + 0.6 * cell
    if (len < 1e-9) {
      stampDisc(w.ax, w.ay, rad)
      continue
    }
    const ux = dx / len
    const uy = dy / len
    const ext = w.thick / 2
    const total = len + 2 * ext
    const steps = Math.max(1, Math.ceil(total / (cell * 0.5)))
    for (let k = 0; k <= steps; k++) {
      const s = -ext + (total * k) / steps
      stampDisc(w.ax + ux * s, w.ay + uy * s, rad)
    }
  }
  // label connected free components (4-neighbourhood)
  const label = new Int32Array(gw * gh)
  const stack: number[] = []
  const comps: Array<{ cells: number[] }> = []
  let next = 0
  for (let start = 0; start < gw * gh; start++) {
    if (blocked[start] || label[start]) continue
    next++
    const cells: number[] = []
    stack.length = 0
    stack.push(start)
    label[start] = next
    while (stack.length) {
      const c = stack.pop()!
      cells.push(c)
      const x = c % gw
      const y = (c - x) / gw
      if (x > 0 && !blocked[c - 1] && !label[c - 1]) { label[c - 1] = next; stack.push(c - 1) }
      if (x < gw - 1 && !blocked[c + 1] && !label[c + 1]) { label[c + 1] = next; stack.push(c + 1) }
      if (y > 0 && !blocked[c - gw] && !label[c - gw]) { label[c - gw] = next; stack.push(c - gw) }
      if (y < gh - 1 && !blocked[c + gw] && !label[c + gw]) { label[c + gw] = next; stack.push(c + gw) }
    }
    comps.push({ cells })
  }
  const outside = label[0]
  const rooms: RoomRegion[] = []
  for (let k = 0; k < comps.length; k++) {
    const id = k + 1
    if (id === outside) continue
    const cells = comps[k].cells
    const areaCells = cells.length * cell * cell
    if (areaCells < minAreaPt2 || areaCells > maxAreaFrac * W * H) continue
    // discard if it touches the grid boundary
    let touches = false
    for (const c of cells) {
      const x = c % gw
      const y = (c - x) / gw
      if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) {
        touches = true
        break
      }
    }
    if (touches) continue
    const ring = traceOuter(label, gw, gh, id, cells)
    if (!ring || ring.length < 3) continue
    const pts = ring.map((p) => ({ x: (p.x - off) * cell, y: (p.y - off) * cell }))
    const simp = simplifyRing(pts, cell * 0.6)
    if (simp.length < 3) continue
    rooms.push({ polygon: simp, areaPt2: polygonArea(simp) })
  }
  // deterministic order: top-to-bottom, left-to-right by bbox
  rooms.sort((a, b) => {
    const ba = bboxOf(a.polygon)
    const bb = bboxOf(b.polygon)
    return ba.minY - bb.minY || ba.minX - bb.minX
  })
  return rooms
}

/** Outer boundary ring (clockwise on screen) of a component, in cell-corner coordinates. */
function traceOuter(label: Int32Array, gw: number, gh: number, id: number, cells: number[]): Point[] | undefined {
  // directions: 0=E 1=S 2=W 3=N; interior on the right
  const DX = [1, 0, -1, 0]
  const DY = [0, 1, 0, -1]
  const vw = gw + 1
  const edges: Array<{ sx: number; sy: number; d: number; used: boolean }> = []
  const out = new Map<number, number[]>()
  const same = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh && label[y * gw + x] === id
  const add = (sx: number, sy: number, d: number) => {
    const k = sy * vw + sx
    const l = out.get(k)
    const idx = edges.push({ sx, sy, d, used: false }) - 1
    if (l) l.push(idx)
    else out.set(k, [idx])
  }
  for (const c of cells) {
    const x = c % gw
    const y = (c - x) / gw
    if (!same(x, y - 1)) add(x, y, 0)
    if (!same(x + 1, y)) add(x + 1, y, 1)
    if (!same(x, y + 1)) add(x + 1, y + 1, 2)
    if (!same(x - 1, y)) add(x, y + 1, 3)
  }
  let best: Point[] | undefined
  let bestArea = 0
  for (let s = 0; s < edges.length; s++) {
    if (edges[s].used) continue
    const ring: Point[] = []
    let e = s
    for (;;) {
      const ed = edges[e]
      ed.used = true
      ring.push({ x: ed.sx, y: ed.sy })
      const ex = ed.sx + DX[ed.d]
      const ey = ed.sy + DY[ed.d]
      const cand = out.get(ey * vw + ex)
      let nxt = -1
      if (cand) {
        for (const turn of [1, 0, 3]) {
          const want = (ed.d + turn) % 4
          const f = cand.find((i) => !edges[i].used && edges[i].d === want)
          if (f !== undefined) {
            nxt = f
            break
          }
        }
      }
      if (nxt < 0) break
      e = nxt
      if (e === s) break
    }
    const a = signedArea(ring)
    if (a > bestArea) {
      bestArea = a
      best = ring
    }
  }
  return best
}
