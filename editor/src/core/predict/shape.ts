import type { BrushSettings, ContextItem, DecisionKind, Path, Point } from '../types'
import {
  add,
  angle,
  angleDiffMod,
  closestPointOnSegment,
  dist,
  minAreaRect,
  normalize,
  scale,
  snapAngle,
  snapPoint,
  sub,
} from '../geometry'
import { nearestDoorFamily, nearestFurnitureFamily, nearestWallType, type TypePalette } from '../context'
import type { Evidence } from './evidence'

/**
 * Refinement step 3 (type from the palette) and the fitted + snapped geometry
 * for the chosen kind. Pure.
 */
export interface Shaped {
  geometry: Path
  type?: string
  targets?: string[]
  evidence: string[]
}

const DEG = Math.PI / 180
const rawPath = (ev: Evidence): Path => ({ points: ev.stroke.points.map((p) => ({ x: p.x, y: p.y })), closed: false })

function wallThicknessPt(item: ContextItem | undefined): number | undefined {
  const t = item?.props?.thicknessPt ? Number(item.props.thicknessPt) : NaN
  return Number.isFinite(t) && t > 0 ? t : undefined
}

function nearbyWall(ev: Evidence, p: Point, radius = 40): ContextItem | undefined {
  if (!ev.hasContext) return undefined
  return ev.pc.lines.itemsNear(p, radius, (i) => i.kind === 'wall')[0]?.item
}

function snapEnd(ev: Evidence, p: Point, s: BrushSettings): { p: Point; ids: string[] } {
  if (!s.snapping || !ev.hasContext) return { p, ids: [] }
  const r = snapPoint(p, ev.pc.lines, { radius: s.snapRadiusPt })
  return r.kind === 'none' ? { p, ids: [] } : { p: r.point, ids: r.itemIds }
}

function shapeWall(ev: Evidence, s: BrushSettings, palette: TypePalette): Shaped {
  const evidence: string[] = []
  const lineFit = ev.fit.line
  const polyFit = ev.fit.polyline
  const usePoly = !!polyFit && ev.f.cornerCount >= 1 && (polyFit.score > (lineFit?.score ?? 0) || ev.straightness < 0.9)
  let verts = usePoly ? polyFit.path.points.map((p) => ({ ...p })) : lineFit ? lineFit.path.points.map((p) => ({ ...p })) : []
  if (verts.length < 2) verts = rawPath(ev).points.filter((_, i, a) => i === 0 || i === a.length - 1)
  const index = ev.hasContext ? ev.pc.lines : undefined
  const snapped: string[] = []
  if (s.snapping) {
    const a = snapEnd(ev, verts[0], s)
    verts[0] = a.p
    snapped.push(...a.ids)
    for (let i = 1; i < verts.length; i++) {
      const ang = snapAngle(verts[i - 1], verts[i], index)
      verts[i] = ang.point
      if (ang.snappedTo !== 'none' && i === 1) evidence.push(`direction snapped to ${ang.snappedTo === 'wall' ? `wall ${ang.itemId ?? ''}`.trim() : 'axis'}`)
    }
    const last = verts.length - 1
    const b = snapEnd(ev, verts[last], s)
    if (b.ids.length) {
      // keep the snapped direction when the snap target lies on it, else take the target
      verts[last] = b.p
      snapped.push(...b.ids)
    }
  }
  if (snapped.length) evidence.push(`endpoints snapped to ${[...new Set(snapped)].join(', ')}`)
  const host = (ev.alongWallId ? ev.pc.lines.getItem(ev.alongWallId) : undefined) ?? nearbyWall(ev, verts[0]) ?? nearbyWall(ev, verts[verts.length - 1])
  const tPt = wallThicknessPt(host)
  const type = tPt !== undefined ? nearestWallType(palette, tPt / ev.ptPerM)?.name : (palette.walls.find((w) => w.thicknessMm === 200) ?? palette.walls[0])?.name
  if (tPt !== undefined) evidence.push(`type from nearby wall thickness ${(tPt / ev.ptPerM).toFixed(2)} m`)
  return { geometry: { points: verts, closed: false }, type, evidence }
}

function shapeDoor(ev: Evidence, _s: BrushSettings, palette: TypePalette, hostIds: string[] | undefined): Shaped {
  const evidence: string[] = []
  const pts = ev.stroke.points
  const a: Point = pts[0]
  const b: Point = pts[pts.length - 1]
  const isArc = (ev.fit.arc?.score ?? 0) > (ev.fit.line?.score ?? 0) && ev.straightness < 0.97
  // width: tick length, or the swing radius (chord / sqrt 2 for a quarter arc)
  const widthPt = isArc ? dist(a, b) / Math.SQRT2 : dist(a, b)
  const mid: Point = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  // A door always sits in a wall: when the scorer named no host (drawn beside the wall rather than
  // across it, or the reading was forced), take the wall nearest the hinge / middle of the stroke.
  let host = hostIds?.length && ev.hasContext ? ev.pc.lines.getItem(hostIds[0]) : undefined
  if (!host) {
    host = nearestDoorWall(ev, isArc ? [a, b] : [mid, a, b], DOOR_SNAP_M * ev.ptPerM)
    if (host) evidence.push(`snapped to nearest wall ${host.id}`)
  }
  const fam = nearestDoorFamily(palette, widthPt / ev.ptPerM)
  const famPt = fam ? (fam.widthMm / 1000) * ev.ptPerM : widthPt
  if (!host) {
    return { geometry: { points: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], closed: false }, type: fam?.name, evidence }
  }
  // host wall segment nearest to the stroke
  const gp = host.geometry.points
  const ref = isArc ? (dist(a, closestOn(gp, a)) < dist(b, closestOn(gp, b)) ? a : b) : crossingPoint(ev, host.id) ?? mid
  let bestSeg = 0
  let bestD = Infinity
  for (let i = 0; i + 1 < gp.length; i++) {
    const c = closestPointOnSegment(ref, gp[i], gp[i + 1])
    if (c.distance < bestD) {
      bestD = c.distance
      bestSeg = i
    }
  }
  const p0 = gp[bestSeg]
  const p1 = gp[Math.min(gp.length - 1, bestSeg + 1)]
  const dir = normalize(sub(p1, p0))
  const onWall = closestPointOnSegment(ref, p0, p1).point
  let start: Point
  let end: Point
  if (isArc) {
    // hinge at the endpoint nearest the wall; opening runs toward the arc's side
    const other = ref === a ? b : a
    const side = Math.sign((other.x - onWall.x) * dir.x + (other.y - onWall.y) * dir.y) || 1
    start = onWall
    end = add(onWall, scale(dir, side * famPt))
  } else {
    start = add(onWall, scale(dir, -famPt / 2))
    end = add(onWall, scale(dir, famPt / 2))
  }
  evidence.push(`placed on host wall ${host.id}`)
  return { geometry: { points: [start, end], closed: false }, type: fam?.name, targets: [host.id], evidence }
}

/** How far (m) a door's hinge / middle may sit from a wall and still be put into it. */
const DOOR_SNAP_M = 0.4

/** Nearest wall to any of the probe points, within `radius` (pt). */
function nearestDoorWall(ev: Evidence, probes: Point[], radius: number): ContextItem | undefined {
  if (!ev.hasContext) return undefined
  let best: ContextItem | undefined
  let bd = Infinity
  for (const p of probes) {
    const hit = ev.pc.lines.itemsNear(p, radius, (i) => i.kind === 'wall')[0]
    if (hit && hit.distance < bd) {
      bd = hit.distance
      best = hit.item
    }
  }
  return best
}

function closestOn(gp: Point[], p: Point): Point {
  let best = gp[0]
  let bd = Infinity
  for (let i = 0; i + 1 < gp.length; i++) {
    const c = closestPointOnSegment(p, gp[i], gp[i + 1])
    if (c.distance < bd) {
      bd = c.distance
      best = c.point
    }
  }
  return best
}

function crossingPoint(ev: Evidence, id: string): Point | undefined {
  return ev.crossings.find((c) => c.itemId === id)?.point
}

function shapeFurniture(ev: Evidence, _s: BrushSettings, palette: TypePalette): Shaped {
  const evidence: string[] = []
  const pts = ev.stroke.points.map((p) => ({ x: p.x, y: p.y }))
  const r = minAreaRect(pts)
  if (!r) return { geometry: { points: pts, closed: true }, evidence }
  // snap orientation to the axes (or the nearest wall direction) within 8 degrees
  let th = r.angle
  const c = { x: (r.corners[0].x + r.corners[2].x) / 2, y: (r.corners[0].y + r.corners[2].y) / 2 }
  const wall = nearbyWall(ev, c, 120)
  const candidates = [0, Math.PI / 2]
  if (wall && wall.geometry.points.length >= 2) candidates.push(angle(sub(wall.geometry.points[1], wall.geometry.points[0])))
  for (const cand of candidates) {
    const d = angleDiffMod(th, cand, Math.PI / 2)
    if (d <= 8 * DEG) {
      const k = Math.round((th - cand) / (Math.PI / 2))
      th = cand + k * (Math.PI / 2)
      break
    }
  }
  const ux = { x: Math.cos(th), y: Math.sin(th) }
  const uy = { x: -Math.sin(th), y: Math.cos(th) }
  const hw = r.w / 2
  const hh = r.h / 2
  const corner = (sx: number, sy: number): Point => add(c, add(scale(ux, sx * hw), scale(uy, sy * hh)))
  const geometry: Path = { points: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], closed: true }
  const wM = r.w / ev.ptPerM
  const hM = r.h / ev.ptPerM
  let fam = nearestFurnitureFamily(palette, wM, hM)
  // room label shifts the family prior (MEETING -> tables, OFFICE -> desks)
  const label = ev.room.label ?? ''
  const prefer = /MEETING|CONFERENCE/i.test(label) ? /table/i : /OFFICE|STUDIO/i.test(label) ? /desk/i : /BED/i.test(label) ? /bed/i : /LIVING|LOUNGE/i.test(label) ? /sofa/i : null
  if (prefer) {
    const a = Math.max(wM, hM) * 1000
    const b = Math.min(wM, hM) * 1000
    let best = fam
    let bd = Infinity
    for (const f of palette.furniture) {
      const d = Math.hypot(Math.max(f.widthMm, f.depthMm) - a, Math.min(f.widthMm, f.depthMm) - b) * (prefer.test(f.name) ? 0.6 : 1)
      if (d < bd) {
        bd = d
        best = f
      }
    }
    if (best && best !== fam) evidence.push(`room ${label} favours ${best.name}`)
    fam = best
  }
  return { geometry, type: fam?.name, evidence }
}

function shapeDelete(ev: Evidence, targets: string[] | undefined): Shaped {
  const b = ev.f.bbox
  return {
    geometry: { points: [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }], closed: true },
    targets: targets?.slice(),
    evidence: [],
  }
}

export function shapeFor(
  kind: DecisionKind,
  ev: Evidence,
  settings: BrushSettings,
  palette: TypePalette,
  targets: Partial<Record<DecisionKind, string[]>>,
): Shaped {
  if (ev.stroke.points.length < 2) return { geometry: rawPath(ev), evidence: [] }
  switch (kind) {
    case 'wall':
      return shapeWall(ev, settings, palette)
    case 'door':
      return shapeDoor(ev, settings, palette, targets.door)
    case 'furniture':
      return shapeFurniture(ev, settings, palette)
    case 'delete':
      return shapeDelete(ev, targets.delete)
    case 'markup':
      return { geometry: rawPath(ev), evidence: [] }
  }
}
