import type { ContextItem, Point, PrimitiveFit, PrimitiveKind, Rect, SheetContext, Stroke, StrokeFeatures } from '../types'
import {
  angle,
  angleDiffMod,
  bbox,
  dist,
  inflateRect,
  minAreaRect,
  polygonContains,
  rectsIntersect,
  resampleByCount,
  segmentIntersection,
  snapPoint,
  sub,
  type SnapResult,
} from '../geometry'
import { extractFeatures } from '../stroke'
import { roomAt, type RoomResult } from '../context'
import { prepareContext, ptPerMetre, type PreparedContext, type ViewMode } from './context-cache'

/** Scale assumed when the sheet has none (most plans in the fixtures are 1:100). */
export const ASSUMED_SCALE = 100

/** Distance tolerances in sheet points. */
export const TOL = {
  /** A sample this close to a wall/grid line counts as "along" it. */
  along: 6,
  /** Endpoint proximity to walls/grids. */
  endpoint: 14,
  /** Label proximity for underline/circle-around-label markup. */
  label: 12,
}

export interface Crossing {
  itemId: string
  point: Point
  /** Wall segment direction, radians. */
  wallAngle: number
  /** Angle between the stroke and the wall, 0..pi/2. */
  incidence: number
  /** Position of the crossing along the stroke, 0 = start, 1 = end. */
  u: number
}

/** Where a door-sized stroke meets a wall: through it, through a gap/opening in it, or touching it. */
export interface DoorHost {
  itemId: string
  point: Point
  /** Angle between the stroke's major axis and the wall, 0..pi/2. */
  incidence: number
  /** 0 when the stroke's span crosses the wall itself; > 0 (pt) when it crosses the wall's line in a gap beyond its end. */
  gapPt: number
}

/** Everything the rules look at for one snapshot of a stroke. */
export interface Evidence {
  stroke: Stroke
  f: StrokeFeatures
  fit: Partial<Record<PrimitiveKind, PrimitiveFit>>
  best?: PrimitiveFit
  samples: Point[]
  /**
   * Hairpin turns (> 120 degrees) between consecutive segments of the polyline fit:
   * the zig-zags of a scribble show up here from the first reversal on, while
   * rectangle and L-wall corners (~90 degrees) do not.
   */
  hairpins: number
  /** chord / length, 1 = perfectly straight. */
  straightness: number
  /** Oriented (minimum-area) box of the ink: major side, minor side (pt) and centre. */
  spanPt: number
  thinPt: number
  obbCenter: Point
  obbAngle: number
  /** minor / major side of the oriented box: ~0 for a line (even retraced), ~1 for a square or circle. */
  aspect: number
  /** Ink length / (box w + h): ~2 for a single outline, high for scribbles and loops. */
  inkDensity: number
  /** Self-intersections per metre of ink (looping scribbles). */
  loopsPerM: number
  /** Shortest segment of the polyline fit except the last one (pt), and how many short perpendicular end ticks it has (dimension line). */
  minSegPt: number
  endTicks: number
  /**
   * 0..1, how much the ink sits on a ring around its centre (small spread of the distance to
   * the centre): high for circles and revision clouds that enclose something, low for
   * scribbles that cover an area.
   */
  ringness: number
  /**
   * 0..1, how much the ink reads as a double door's pair of swings: open ends a double-door width
   * apart, ink rising about half that width on one side of their chord in two humps, and coming
   * back to the chord near its middle (where the two leaves meet). Shape only, any drawing order.
   */
  doubleSwing: number
  /** Door-sized stroke's span crossing a wall line (through the wall, or through a gap / opening in it). */
  doorCross?: DoorHost
  /** Wall touched by an endpoint or a corner of the ink's box (door swing hinge). */
  touchWall?: DoorHost
  ptPerM: number
  scaleKnown: boolean
  lengthM: number
  bboxM: { w: number; h: number }
  /** Context present (not a scanned / shape-only sheet). */
  hasContext: boolean
  /** Drawing convention of the sheet (from its sheet type): plan, or elevation / section. */
  view: ViewMode
  /**
   * 0..1, how square to the sheet the ink's oriented box sits (its area / the axis-aligned box's area):
   * elevation openings are drawn upright, with level sills and heads.
   */
  upright: number
  /**
   * 0..1, how much an open stroke reads as an outline open at the bottom (an elevation door drawn as an
   * inverted U): both ends near the bottom of the box, about its width apart.
   */
  openBottom: number
  pc: PreparedContext
  /** Fraction of samples lying on a wall (resp. grid) line, and the dominant item. */
  alongWall: number
  alongGrid: number
  alongWallId?: string
  /** Angle between the stroke's line fit and the nearest wall/grid direction (rad, mod pi), when one is near. */
  alignDiff?: number
  start: SnapResult
  end: SnapResult
  /** Endpoint snaps restricted to walls (door swing arcs hang off walls, not grids). */
  startWall: SnapResult
  endWall: SnapResult
  crossings: Crossing[]
  room: RoomResult
  /** Labels the stroke encloses or runs right under/through. */
  labelsNear: ContextItem[]
  labelInside?: ContextItem
  /** Width of the enclosed label / width of the stroke's box (a ring hugging a label is markup). */
  labelCover: number
  /** Fixtures substantially covered by the stroke's extent. */
  fixturesOver: { item: ContextItem; overlap: number }[]
  /** Walls with a segment inside the stroke's extent (scribble over a wall). */
  wallsOver: { item: ContextItem; near: number }[]
}

const isWall = (i: ContextItem) => i.kind === 'wall'

function rectOverlapFrac(a: Rect, b: Rect): number {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  if (x1 <= x0 || y1 <= y0) return 0
  const area = Math.max(1e-6, a.w * a.h)
  return ((x1 - x0) * (y1 - y0)) / area
}

const trap = (x: number, a: number, b: number, c: number, d: number): number => {
  const r = (lo: number, hi: number) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)))
  return Math.min(r(a, b), 1 - r(c, d))
}

/** See `Evidence.doubleSwing`. Two quarter swings of radius S/2 hinged at the chord ends: height S/2, ink 1.6..2.6 S. */
function doubleSwingness(pts: readonly Point[], lengthPt: number, ptPerM: number): number {
  if (pts.length < 8) return 0
  const a = pts[0]
  const b = pts[pts.length - 1]
  const S = dist(a, b)
  if (S < 1e-6) return 0
  const ux = (b.x - a.x) / S
  const uy = (b.y - a.y) / S
  const t = pts.map((p) => ((p.x - a.x) * ux + (p.y - a.y) * uy) / S)
  const d = pts.map((p) => (-(p.x - a.x) * uy + (p.y - a.y) * ux) / S)
  let iMax = 0
  for (let i = 1; i < d.length; i++) if (Math.abs(d[i]) > Math.abs(d[iMax])) iMax = i
  const side = Math.sign(d[iMax]) || 1
  const h = Math.abs(d[iMax])
  if (h < 1e-6) return 0
  // the return to the chord: the lowest point of the middle half of the ink (by arc length)
  let acc = 0
  let iMid = -1
  for (let i = 1; i < pts.length - 1; i++) {
    acc += dist(pts[i - 1], pts[i])
    const s = acc / lengthPt
    if (s < 0.25 || s > 0.75) continue
    if (iMid < 0 || side * d[i] < side * d[iMid]) iMid = i
  }
  if (iMid < 0) return 0
  const tm = t[iMid]
  // both humps rise: highest point on each side of the meeting point
  let hl = 0
  let hr = 0
  let opp = 0
  for (let i = 0; i < pts.length; i++) {
    const v = side * d[i]
    if (t[i] < tm) hl = Math.max(hl, v)
    else hr = Math.max(hr, v)
    opp = Math.max(opp, -v)
  }
  return (
    trap(S / ptPerM, 1.0, 1.2, 2.4, 2.8) *
    trap(h, 0.3, 0.38, 0.62, 0.75) *
    trap(tm, 0.25, 0.35, 0.65, 0.75) *
    (1 - Math.max(0, Math.min(1, (side * d[iMid] / h - 0.15) / 0.15))) *
    Math.max(0, Math.min(1, (Math.min(hl, hr) / h - 0.5) / 0.2)) *
    (1 - Math.max(0, Math.min(1, (opp / h - 0.1) / 0.15))) *
    trap(lengthPt / S, 1.3, 1.5, 3.0, 3.4)
  )
}

const HAIRPIN = (120 * Math.PI) / 180

function countHairpins(v: readonly Point[]): number {
  let n = 0
  for (let i = 1; i + 1 < v.length; i++) {
    const a = angle(sub(v[i], v[i - 1]))
    const b = angle(sub(v[i + 1], v[i]))
    let d = Math.abs(a - b) % (2 * Math.PI)
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d > HAIRPIN) n++
  }
  return n
}

const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** Shortest segment and perpendicular end ticks of a polyline fit. */
function segmentStats(v: readonly Point[]): { minSeg: number; endTicks: number } {
  if (v.length < 2) return { minSeg: 0, endTicks: 0 }
  const segs: number[] = []
  for (let i = 1; i < v.length; i++) segs.push(dist(v[i - 1], v[i]))
  const total = segs.reduce((a, b) => a + b, 0)
  let ticks = 0
  if (v.length >= 3) {
    const turn = (a: Point, b: Point, c: Point) => angleDiffMod(angle(sub(b, a)), angle(sub(c, b)))
    // a short first/last segment (< 15% of the ink) at roughly right angles to its neighbour
    if (segs[0] < 0.15 * total && turn(v[0], v[1], v[2]) > (55 * Math.PI) / 180) ticks++
    const n = v.length - 1
    if (segs[n - 1] < 0.15 * total && turn(v[n - 2], v[n - 1], v[n]) > (55 * Math.PI) / 180) ticks++
  }
  // the last segment is still being drawn, so it does not count as "short"
  return { minSeg: Math.min(...(segs.length >= 2 ? segs.slice(0, -1) : segs)), endTicks: ticks }
}

const GAP_M = 1.3

/**
 * The door-sized stroke's major axis against wall centrelines: a crossing through the wall,
 * or through the wall's line within GAP_M beyond one of its ends (an opening between wall
 * pieces), or through an `opening` item. Prefers real crossings, then steeper incidence.
 */
function findDoorHost(ev: Evidence, pc: PreparedContext): { cross?: DoorHost; touch?: DoorHost } {
  const c = ev.obbCenter
  const dir = { x: Math.cos(ev.obbAngle), y: Math.sin(ev.obbAngle) }
  const half = ev.spanPt / 2
  const a = { x: c.x - dir.x * half * 1.1, y: c.y - dir.y * half * 1.1 }
  const b = { x: c.x + dir.x * half * 1.1, y: c.y + dir.y * half * 1.1 }
  const gap = GAP_M * ev.ptPerM
  const radius = half + gap + 10
  let cross: DoorHost | undefined
  let touch: DoorHost | undefined
  const better = (x: DoorHost, y?: DoorHost) => !y || x.gapPt < y.gapPt - 1e-9 || (Math.abs(x.gapPt - y.gapPt) <= 1e-9 && x.incidence > y.incidence)
  const pts = ev.stroke.points
  const probes: Point[] = pts.length ? [pts[0], pts[pts.length - 1]] : []
  for (const h of pc.all.itemsNear(c, radius, (i) => i.kind === 'wall' || i.kind === 'opening')) {
    const it = h.item
    const gp = it.geometry.points
    const thick = Number(it.props?.thicknessPt ?? 0) || 4
    for (let k = 0; k + 1 < gp.length; k++) {
      const p0 = gp[k]
      const p1 = gp[k + 1]
      const L = dist(p0, p1)
      if (L < 1e-6) continue
      const u = { x: (p1.x - p0.x) / L, y: (p1.y - p0.y) / L }
      const ext = it.kind === 'opening' ? 0.2 * ev.ptPerM : gap
      const q0 = { x: p0.x - u.x * ext, y: p0.y - u.y * ext }
      const q1 = { x: p1.x + u.x * ext, y: p1.y + u.y * ext }
      const wallAngle = angle(u)
      const x = segmentIntersection(a, b, q0, q1)
      if (x && x.t > 0.12 && x.t < 0.88) {
        const along = x.u * (L + 2 * ext) - ext // position along the real segment
        const gapPt = it.kind === 'opening' ? 0 : along < 0 ? -along : along > L ? along - L : 0
        const cand: DoorHost = { itemId: it.id, point: x.point, incidence: angleDiffMod(ev.obbAngle, wallAngle), gapPt }
        if (better(cand, cross)) cross = cand
      }
      // touching: an endpoint of the ink on the wall's line (within its thickness), inside the extended segment
      for (const p of probes) {
        const w = { x: p.x - q0.x, y: p.y - q0.y }
        const along = w.x * u.x + w.y * u.y
        const off = Math.abs(w.x * -u.y + w.y * u.x)
        if (along < 0 || along > L + 2 * ext || off > thick / 2 + 6) continue
        const real = along - ext
        const gapPt = it.kind === 'opening' ? 0 : real < 0 ? -real : real > L ? real - L : 0
        const cand: DoorHost = { itemId: it.id, point: p, incidence: angleDiffMod(ev.obbAngle, wallAngle), gapPt }
        if (better(cand, touch)) touch = cand
      }
    }
  }
  return { cross, touch }
}

/** Compute features and context relations for the current stroke snapshot. */
export function gatherEvidence(stroke: Stroke, ctx: SheetContext, opts: { snapRadiusPt?: number } = {}): Evidence {
  const pc = prepareContext(ctx)
  const scaleKnown = pc.ptPerM !== undefined
  const ptPerM = pc.ptPerM ?? ptPerMetre(ASSUMED_SCALE)
  const f = extractFeatures(stroke, { scale: ctx.scale })
  const fit: Evidence['fit'] = {}
  for (const x of f.fits) if (!fit[x.kind]) fit[x.kind] = x
  const pts: Point[] = stroke.points.map((p) => ({ x: p.x, y: p.y }))
  const samples = pts.length >= 2 && f.lengthPt > 1e-6 ? resampleByCount(pts, 32) : pts.slice(0, 1)
  const first = pts[0] ?? { x: 0, y: 0 }
  const last = pts[pts.length - 1] ?? first
  const straightness = f.lengthPt > 1e-6 ? dist(first, last) / f.lengthPt : 1
  const none: SnapResult = { point: first, kind: 'none', itemIds: [], distance: 0 }
  const ev: Evidence = {
    stroke,
    f,
    fit,
    best: f.fits[0],
    samples,
    straightness,
    hairpins: countHairpins(fit.polyline?.path.points ?? []),
    spanPt: 0,
    thinPt: 0,
    obbCenter: first,
    obbAngle: 0,
    aspect: 0,
    inkDensity: 0,
    loopsPerM: 0,
    minSegPt: 0,
    endTicks: 0,
    ringness: 0,
    doubleSwing: 0,
    ptPerM,
    scaleKnown,
    lengthM: f.lengthPt / ptPerM,
    bboxM: { w: f.bbox.w / ptPerM, h: f.bbox.h / ptPerM },
    hasContext: !pc.shapeOnly,
    view: pc.view,
    upright: 0,
    openBottom: 0,
    pc,
    alongWall: 0,
    alongGrid: 0,
    start: none,
    end: { ...none, point: last },
    startWall: none,
    endWall: { ...none, point: last },
    crossings: [],
    room: {},
    labelsNear: [],
    labelCover: 0,
    fixturesOver: [],
    wallsOver: [],
  }
  if (pts.length >= 3) {
    const r = minAreaRect(pts)
    if (r) {
      const major = Math.max(r.w, r.h)
      const minor = Math.min(r.w, r.h)
      ev.spanPt = major
      ev.thinPt = minor
      ev.aspect = major > 1e-9 ? minor / major : 0
      ev.obbCenter = { x: (r.corners[0].x + r.corners[2].x) / 2, y: (r.corners[0].y + r.corners[2].y) / 2 }
      ev.obbAngle = r.w >= r.h ? r.angle : r.angle + Math.PI / 2
    }
  } else if (pts.length === 2) {
    ev.spanPt = dist(pts[0], pts[1])
    ev.obbCenter = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
    ev.obbAngle = angle(sub(pts[1], pts[0]))
  }
  const boxArea = f.bbox.w * f.bbox.h
  ev.upright = boxArea > 1e-9 && pts.length >= 3 ? Math.min(1, (ev.spanPt * ev.thinPt) / boxArea) : 0
  if (pts.length >= 3 && f.bbox.w > 1e-9 && f.bbox.h > 1e-9) {
    const bottom = f.bbox.y + f.bbox.h
    const low = (p: Point) => 1 - Math.max(0, Math.min(1, ((bottom - p.y) / f.bbox.h - 0.1) / 0.15))
    const apart = Math.abs(last.x - first.x) / f.bbox.w
    ev.openBottom = low(first) * low(last) * Math.max(0, Math.min(1, (apart - 0.6) / 0.25))
  }
  ev.inkDensity = f.bbox.w + f.bbox.h > 1e-9 ? f.lengthPt / (f.bbox.w + f.bbox.h) : 0
  ev.loopsPerM = ev.lengthM > 1e-9 ? f.selfIntersections / ev.lengthM : 0
  const st = segmentStats(fit.polyline?.path.points ?? [])
  ev.minSegPt = st.minSeg
  ev.endTicks = st.endTicks
  if (samples.length >= 8 && ev.aspect >= 0.3) {
    const c0 = ev.obbCenter
    // distances normalised per axis so an oval counts as a ring too
    const ux = { x: Math.cos(ev.obbAngle), y: Math.sin(ev.obbAngle) }
    const a = Math.max(ev.spanPt / 2, 1e-6)
    const b = Math.max(ev.thinPt / 2, 1e-6)
    const ds = samples.map((p) => {
      const dx = p.x - c0.x
      const dy = p.y - c0.y
      const u = (dx * ux.x + dy * ux.y) / a
      const v = (-dx * ux.y + dy * ux.x) / b
      return Math.hypot(u, v)
    })
    const mean = ds.reduce((x, y) => x + y, 0) / ds.length
    const sd = Math.sqrt(ds.reduce((x, y) => x + (y - mean) * (y - mean), 0) / ds.length)
    ev.ringness = mean > 1e-9 ? 1 - Math.max(0, Math.min(1, (sd / mean - 0.12) / 0.15)) : 0
  }

  // a pair of swings turns back on itself once or twice (the cusp where the leaves meet); a zig-zag scribble many times
  const reversals = (f.reversalDensity * f.lengthPt) / 100
  ev.doubleSwing = doubleSwingness(pts, f.lengthPt, ptPerM) * (1 - Math.max(0, Math.min(1, (ev.hairpins - 3) / 2))) * (1 - Math.max(0, Math.min(1, (reversals - 4) / 2)))

  if (pc.shapeOnly || pts.length === 0) return ev

  const dh = findDoorHost(ev, pc)
  ev.doorCross = dh.cross
  ev.touchWall = dh.touch

  // along walls / grids
  const counts = new Map<string, number>()
  let nWall = 0
  let nGrid = 0
  for (const s of samples) {
    const hits = pc.lines.itemsNear(s, TOL.along)
    if (!hits.length) continue
    const w = hits.find((h) => h.item.kind === 'wall')
    if (w) {
      nWall++
      counts.set(w.item.id, (counts.get(w.item.id) ?? 0) + 1)
    }
    if (hits.some((h) => h.item.kind === 'grid')) nGrid++
  }
  ev.alongWall = nWall / samples.length
  ev.alongGrid = nGrid / samples.length
  let bestN = 0
  for (const [id, n] of counts) if (n > bestN || (n === bestN && ev.alongWallId !== undefined && id < ev.alongWallId)) {
    bestN = n
    ev.alongWallId = id
  }

  // alignment with the nearest wall/grid direction (line fit direction)
  const line = fit.line
  if (line && line.path.points.length >= 2) {
    const a = line.path.points[0]
    const b = line.path.points[line.path.points.length - 1]
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const near = pc.lines.itemsNear(mid, Math.max(20, f.lengthPt / 2))
    if (near.length) {
      const h = near[0]
      const gp = h.item.geometry.points
      if (gp.length >= 2) {
        const wa = angle(sub(gp[(h.segIndex + 1) % gp.length], gp[h.segIndex]))
        ev.alignDiff = angleDiffMod(angle(sub(b, a)), wa)
      }
    }
  }

  // endpoints
  const radius = Math.max(opts.snapRadiusPt ?? 8, TOL.endpoint)
  ev.start = snapPoint(first, pc.lines, { radius })
  ev.end = snapPoint(last, pc.lines, { radius })
  ev.startWall = snapPoint(first, pc.lines, { radius, kinds: ['wall'] })
  ev.endWall = snapPoint(last, pc.lines, { radius, kinds: ['wall'] })

  // crossings with walls
  const crossed = new Map<string, Crossing>()
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    const r = inflateRect(bbox([a, b]), 1)
    for (const w of pc.lines.itemsInRect(r, isWall)) {
      if (crossed.has(w.id)) continue
      const gp = w.geometry.points
      const n = w.geometry.closed ? gp.length : gp.length - 1
      for (let k = 0; k < n; k++) {
        const c = gp[k]
        const d = gp[(k + 1) % gp.length]
        const x = segmentIntersection(a, b, c, d)
        if (!x) continue
        const wallAngle = angle(sub(d, c))
        crossed.set(w.id, {
          itemId: w.id,
          point: x.point,
          wallAngle,
          incidence: angleDiffMod(angle(sub(b, a)), wallAngle),
          u: (i - 1 + x.t) / (samples.length - 1),
        })
        break
      }
    }
  }
  ev.crossings = [...crossed.values()]

  // room
  ev.room = roomAt(ctx, center(f.bbox))

  // labels
  const sb = f.bbox
  const near = inflateRect(sb, TOL.label)
  for (const { item, box } of pc.labels) {
    if (!rectsIntersect(near, box)) continue
    ev.labelsNear.push(item)
    if (!ev.labelInside && f.closureRatio < 0.35 && samples.length >= 3 && polygonContains(samples, center(box))) {
      ev.labelInside = item
      ev.labelCover = box.w / Math.max(1e-6, sb.w)
    }
  }

  // fixtures and walls under the stroke (delete)
  for (const { item, box } of pc.fixtures) {
    const ov = rectOverlapFrac(box, sb)
    if (ov > 0.25) ev.fixturesOver.push({ item, overlap: ov })
  }
  ev.fixturesOver.sort((a, b) => b.overlap - a.overlap || (a.item.id < b.item.id ? -1 : 1))
  for (const w of pc.lines.itemsInRect(sb, isWall)) {
    let n = 0
    for (const s of samples) if (pc.lines.itemsNear(s, Math.max(TOL.along, 10), (i) => i.id === w.id).length) n++
    ev.wallsOver.push({ item: w, near: n / samples.length })
  }
  ev.wallsOver.sort((a, b) => b.near - a.near || (a.item.id < b.item.id ? -1 : 1))
  return ev
}
