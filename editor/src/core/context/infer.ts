import type { ContextItem, Path, Point, RawPageContent, RawPath, RawText, SheetContext } from '../types'
import { hyp, pointInPolygon, bboxOf } from './internal/math'
import { classifyPath, type PathInfo } from './internal/shapes'
import { findDimensions, findHatch, findLadders, makeSeg, type Seg } from './internal/segments'
import { findArcOpenings, findOpenings, findWallPairs, mergeCollinear, snapCorners, type WallRun } from './internal/walls'
import { buildRooms } from './rooms'
import { findScale, ptPerMetre } from './scale'
import { isGridLabel, isNumericDim, isRoomLabel } from './text'
import { detectFrame, textCenter } from './titleblock'

export interface InferOptions {
  /** Override the scale found in text (100 for 1:100). */
  scale?: number
  /** Build room regions (default true). */
  rooms?: boolean
  /** Raster cell for room detection in pt (default 3). */
  cellPt?: number
}

/** Tunable thresholds (starting values). */
export const THRESHOLDS = {
  wallGapLoPt: 3,
  wallGapHiPt: 20,
  minSegLenPt: 12,
  thickStrokePt: 1.5,
  thickMinLenM: 1,
  gridMinSpanFrac: 0.3,
  bubbleRadiusPt: [6, 20] as const,
  symbolSizeM: [0.4, 3] as const,
  doorWidthM: [0.6, 2.4] as const,
  minConfidence: 0.3,
}

interface Circle {
  cx: number
  cy: number
  r: number
  path: number
}

function cmpPos(ax: number, ay: number, bx: number, by: number): number {
  const dy = Math.round(ay * 10) - Math.round(by * 10)
  return dy || Math.round(ax * 10) - Math.round(bx * 10)
}

function pathOf(points: Point[], closed: boolean): Path {
  return { points, closed }
}

function round2(n: number): string {
  return String(Math.round(n * 100) / 100)
}

export function inferContext(raw: RawPageContent, opts: InferOptions = {}): SheetContext {
  const empty = !raw.paths.length && !raw.texts.length
  if (raw.hasRasterOnly || empty) {
    return { sheetId: raw.sheetId, origin: 'inferred', items: [], shapeOnly: true }
  }
  const T = THRESHOLDS
  const W = raw.sizePt.w
  const H = raw.sizePt.h
  const infos: PathInfo[] = raw.paths.map(classifyPath)
  const frame = detectFrame(raw, infos)
  const inTB = (t: RawText) => {
    const c = textCenter(t)
    return frame.inTitleBlock(c.x, c.y)
  }
  const scale = opts.scale ?? findScale(raw.texts, inTB)
  const ppm = ptPerMetre(scale ?? 100)
  const [symLo, symHi] = T.symbolSizeM.map((m) => m * ppm)
  const wallLo = scale ? Math.max(2, Math.min(T.wallGapLoPt, 0.08 * ppm)) : T.wallGapLoPt
  const wallHi = scale ? Math.max(T.wallGapHiPt, 0.55 * ppm) : T.wallGapHiPt

  // ---- classify paths; explode stroked ones into segments ----
  const circles: Circle[] = []
  const symbols: Array<{ info: PathInfo; path: number; shape: 'rect' | 'circle' }> = []
  const arcs: Point[][] = []
  const pocheRuns: WallRun[] = []
  const segs: Seg[] = []
  const thinOutlines: number[] = []
  for (let pi = 0; pi < raw.paths.length; pi++) {
    const p = raw.paths[pi]
    const info = infos[pi]
    if (info.pts.length < 2) continue
    if (info.kind === 'round') {
      circles.push({ cx: info.cx, cy: info.cy, r: info.r!, path: pi })
      const d = 2 * info.r!
      if (d >= symLo && d <= symHi) symbols.push({ info, path: pi, shape: 'circle' })
      continue
    }
    if (info.kind === 'curvy') {
      arcs.push(info.pts)
      continue
    }
    if (info.kind === 'rect') {
      const w = info.w!
      const h = info.h!
      const lo = Math.min(w, h)
      const hi = Math.max(w, h)
      if (p.filled && hi > 4 * lo && lo >= wallLo && lo <= wallHi && hi >= 15) {
        // filled thin rectangle: poche wall
        const horiz = w >= h
        const e0 = info.pts[0]
        const e1 = info.pts[1]
        const e3 = info.pts[3]
        const ax0 = horiz ? (e0.x + e3.x) / 2 : (e0.x + e1.x) / 2
        const ay0 = horiz ? (e0.y + e3.y) / 2 : (e0.y + e1.y) / 2
        const ex = horiz ? (e1.x + info.pts[2].x) / 2 : (e3.x + info.pts[2].x) / 2
        const ey = horiz ? (e1.y + info.pts[2].y) / 2 : (e3.y + info.pts[2].y) / 2
        // long axis runs between the midpoints of the two short edges
        pocheRuns.push({ ax: ax0, ay: ay0, bx: ex, by: ey, thick: lo, kind: 'poche', lw: p.lineWidth, sameLw: 1, connected: 0 })
        continue
      }
      if (lo >= symLo && hi <= symHi && hi <= 4 * lo) {
        symbols.push({ info, path: pi, shape: 'rect' })
        continue
      }
    }
    if (!p.stroked) continue
    // an isolated thin closed rectangle outline (cabinet, partition stall) is a fixture, not a wall
    if (info.kind === 'rect' && info.closed && !p.filled && isThinOutline(info, wallLo, wallHi)) thinOutlines.push(pi)
    const pts = info.pts
    const dashed = !!p.dash && p.dash.length > 0 && p.dash.some((d) => d > 0)
    const n = pts.length
    const last = info.closed ? n : n - 1
    for (let i = 0; i < last; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const s = makeSeg(a.x, a.y, b.x, b.y, p.lineWidth, dashed, pi)
      if (s) segs.push(s)
    }
  }

  // exclude title block / border area
  const live: number[] = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (!frame.inTitleBlock((s.ax + s.bx) / 2, (s.ay + s.by) / 2)) live.push(i)
  }
  const solid = live.filter((i) => !segs[i].dashed)
  const dashed = live.filter((i) => segs[i].dashed)

  // ---- reject hatches and dimension lines ----
  const hatch = findHatch(segs, solid)
  const ladders = findLadders(segs, solid)
  // thin closed outlines (cabinet, partition stall, stair rail) that nothing but a ladder touches are fixtures
  const ladderSrc = new Set<number>()
  for (const i of solid) if (ladders[i]) ladderSrc.add(segs[i].src)
  const notWall = new Set<number>(thinOutlines.filter((pi) => !touchedByOthers(infos[pi], raw.paths, pi, ladderSrc)))
  const dimPool = solid.filter((i) => !hatch[i] && !ladders[i] && !notWall.has(segs[i].src))
  const dims = findDimensions(segs, dimPool, raw.texts)
  const wallPool = dimPool.filter((i) => !dims.mask[i] && segs[i].len >= T.minSegLenPt)

  // ---- walls ----
  const pairs = findWallPairs(segs, wallPool, wallLo, wallHi)
  const pairRuns = mergeCollinear(pairs.runs)
  const thickSegRuns: WallRun[] = []
  for (const i of wallPool) {
    const s = segs[i]
    if (pairs.used[i] || s.lw < T.thickStrokePt) continue
    thickSegRuns.push({ ax: s.ax, ay: s.ay, bx: s.bx, by: s.by, thick: s.lw, kind: 'thick', lw: s.lw, sameLw: 1, connected: 0 })
  }
  const thickMin = T.thickMinLenM * ppm
  const thickRuns = mergeCollinear(thickSegRuns, 2, 0.6, 2.5).filter((r) => hyp(r.bx - r.ax, r.by - r.ay) >= thickMin)
  const pocheMerged = mergeCollinear(pocheRuns)
  let runs: WallRun[] = [...pairRuns, ...thickRuns, ...pocheMerged]
  // drop runs lying in the title block
  runs = runs.filter((r) => !frame.inTitleBlock((r.ax + r.bx) / 2, (r.ay + r.by) / 2))
  snapCorners(runs)
  runs.sort((a, b) => cmpPos((a.ax + a.bx) / 2, (a.ay + a.by) / 2, (b.ax + b.bx) / 2, (b.ay + b.by) / 2))

  const wallConf = (r: WallRun): number => {
    const len = hyp(r.bx - r.ax, r.by - r.ay)
    let c: number
    if (r.kind === 'pair') {
      c = 0.45 + 0.1 * r.sameLw + (len >= 60 ? 0.1 : len < 24 ? -0.1 : 0) + (r.connected === 2 ? 0.15 : r.connected === 1 ? 0.07 : 0)
      if (r.lw >= 1) c += 0.05
    } else if (r.kind === 'poche') {
      c = 0.6 + (len >= 60 ? 0.1 : 0) + (r.connected === 2 ? 0.15 : r.connected === 1 ? 0.07 : 0)
    } else {
      c = 0.35 + (r.lw >= 2.5 ? 0.1 : 0) + (len >= 3 * ppm ? 0.1 : 0) + (r.connected === 2 ? 0.15 : r.connected === 1 ? 0.07 : 0)
    }
    return Math.max(T.minConfidence, Math.min(0.95, c))
  }

  const items: ContextItem[] = []
  const wallItems: ContextItem[] = runs.map((r, i) => ({
    id: `wall-${i + 1}`,
    kind: 'wall' as const,
    geometry: pathOf(
      [
        { x: r.ax, y: r.ay },
        { x: r.bx, y: r.by },
      ],
      false,
    ),
    confidence: round3(wallConf(r)),
    props: { thicknessPt: round2(r.thick), source: r.kind },
  }))

  // ---- openings ----
  const gapMin = T.doorWidthM[0] * ppm
  const gapMax = T.doorWidthM[1] * ppm
  const hits = findOpenings(runs, arcs, gapMin, gapMax)
  hits.push(...findArcOpenings(runs, arcs, hits, gapMin, gapMax))
  hits.sort((a, b) => cmpPos(a.a.x + a.b.x, a.a.y + a.b.y, b.a.x + b.b.x, b.a.y + b.b.y))
  const openingItems: ContextItem[] = hits.map((h, i) => ({
    id: `opening-${i + 1}`,
    kind: 'opening' as const,
    geometry: pathOf([h.a, h.b], false),
    confidence: round3(Math.min(0.9, 0.55 + 0.3 * Math.min(wallItems[h.hostA].confidence, wallItems[h.hostB].confidence))),
    props: {
      widthPt: round2(h.widthPt),
      swing: 'arc',
      hinge: `${round2(h.hinge.x)},${round2(h.hinge.y)}`,
      hostWalls: `${wallItems[h.hostA].id},${wallItems[h.hostB].id}`,
    },
  }))

  // ---- grids ----
  const gridItems: ContextItem[] = []
  const gridTextIdx = new Set<number>()
  const minSpan = Math.max(100, T.gridMinSpanFrac * Math.min(W, H))
  const gridSegs = [...dashed, ...solid.filter((i) => segs[i].lw <= 1.5 && segs[i].len >= minSpan)]
  const gridRuns = mergeCollinear(
    gridSegs.map((i) => {
      const s = segs[i]
      return { ax: s.ax, ay: s.ay, bx: s.bx, by: s.by, thick: 0, kind: s.dashed ? ('pair' as const) : ('thick' as const), lw: s.lw, sameLw: 1, connected: 0 }
    }),
    1.5,
    1,
    // dashed lines may be split into several paths; allow modest gaps
    12,
  )
  const bubbles = circles.filter((c) => c.r >= T.bubbleRadiusPt[0] && c.r <= T.bubbleRadiusPt[1])
  const usedBubbles = new Set<number>()
  const labelIdx = raw.texts.map((t, i) => ({ t, i })).filter(({ t }) => isGridLabel(t.text))
  const gridCands: Array<{ run: WallRun; len: number; dashed: boolean }> = gridRuns
    .map((run) => ({ run, len: hyp(run.bx - run.ax, run.by - run.ay), dashed: run.kind === 'pair' }))
    .filter((g) => g.len >= minSpan && !frame.inTitleBlock((g.run.ax + g.run.bx) / 2, (g.run.ay + g.run.by) / 2))
  gridCands.sort((a, b) => cmpPos((a.run.ax + a.run.bx) / 2, (a.run.ay + a.run.by) / 2, (b.run.ax + b.run.bx) / 2, (b.run.ay + b.run.by) / 2))
  for (const g of gridCands) {
    const ends: Point[] = [
      { x: g.run.ax, y: g.run.ay },
      { x: g.run.bx, y: g.run.by },
    ]
    let conf = g.dashed ? 0.35 : 0.2
    let label: string | undefined
    let bubbleCount = 0
    let labelEnd = -1
    for (let e = 0; e < 2; e++) {
      const E = ends[e]
      let bestB = -1
      let bestD = Infinity
      bubbles.forEach((b, bi) => {
        if (usedBubbles.has(bi)) return
        const d = hyp(b.cx - E.x, b.cy - E.y)
        if (d <= b.r || Math.abs(d - b.r) <= Math.max(4, 0.5 * b.r)) {
          if (d < bestD) {
            bestD = d
            bestB = bi
          }
        }
      })
      if (bestB >= 0) {
        const b = bubbles[bestB]
        usedBubbles.add(bestB)
        bubbleCount++
        const inside = labelIdx.find(({ t }) => {
          const c = textCenter(t)
          return hyp(c.x - b.cx, c.y - b.cy) <= b.r
        })
        if (inside && label === undefined) {
          label = inside.t.text.trim()
          labelEnd = e
          gridTextIdx.add(inside.i)
        } else if (inside) gridTextIdx.add(inside.i)
      }
    }
    if (bubbleCount) conf += 0.3
    if (label !== undefined) conf += 0.25
    else {
      // label without a drawn bubble, near an end
      for (let e = 0; e < 2 && label === undefined; e++) {
        const near = labelIdx.find(({ t }) => {
          const c = textCenter(t)
          return hyp(c.x - ends[e].x, c.y - ends[e].y) <= 25
        })
        if (near) {
          label = near.t.text.trim()
          labelEnd = e
          gridTextIdx.add(near.i)
          conf += 0.2
        }
      }
    }
    if (bubbleCount === 2) conf += 0.05
    if (conf < 0.55) continue
    void labelEnd
    gridItems.push({
      id: `grid-${gridItems.length + 1}`,
      kind: 'grid',
      geometry: pathOf(ends, false),
      text: label,
      confidence: round3(Math.min(0.95, conf)),
      props: { ...(label !== undefined ? { label } : {}), dashed: g.dashed ? '1' : '0', bubbles: String(bubbleCount) },
    })
  }

  // ---- rooms ----
  const roomItems: ContextItem[] = []
  const roomPolys: Point[][] = []
  const roomLabelText: Array<string | undefined> = []
  const solidWalls = wallItems.filter((w) => w.confidence >= 0.4)
  if (opts.rooms !== false && solidWalls.length) {
    const stamps = runs
      .map((r, i) => ({ r, w: wallItems[i] }))
      .filter(({ w }) => w.confidence >= 0.4)
      .map(({ r }) => ({ ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, thick: r.thick }))
    for (const h of hits) {
      const ra = runs[h.hostA]
      const rb = runs[h.hostB]
      stamps.push({ ax: h.a.x, ay: h.a.y, bx: h.b.x, by: h.b.y, thick: (ra.thick + rb.thick) / 2 })
    }
    const regions = buildRooms(W, H, stamps, opts.cellPt ?? 3, 0.7 * ppm * ppm)
    const roomTexts = raw.texts
      .map((t, i) => ({ t, i, c: textCenter(t) }))
      .filter(({ t, i, c }) => isRoomLabel(t.text) && !gridTextIdx.has(i) && !frame.inTitleBlock(c.x, c.y))
    regions.forEach((reg, ri) => {
      const bb = bboxOf(reg.polygon)
      let best: (typeof roomTexts)[number] | undefined
      for (const rt of roomTexts) {
        if (rt.c.x < bb.minX || rt.c.x > bb.maxX || rt.c.y < bb.minY || rt.c.y > bb.maxY) continue
        if (!pointInPolygon(rt.c.x, rt.c.y, reg.polygon)) continue
        if (!best || rt.t.height > best.t.height) best = rt
      }
      const label = best?.t.text.trim().replace(/\s+/g, ' ')
      roomPolys.push(reg.polygon)
      roomLabelText.push(label)
      roomItems.push({
        id: `unknown-${ri + 1}`,
        kind: 'unknown',
        geometry: pathOf(reg.polygon, true),
        confidence: round3(Math.min(0.8, 0.5 + (label ? 0.15 : 0) + (reg.polygon.length <= 8 ? 0.1 : 0))),
        props: { role: 'room', ...(label ? { label } : {}), areaPt2: round2(reg.areaPt2) },
      })
    })
  }

  // ---- fixtures ----
  const fixtureItems: ContextItem[] = []
  if (roomPolys.length) {
    const bubbleSet = new Set(usedBubbles.size ? [...usedBubbles].map((bi) => bubbles[bi].path) : [])
    const cands = symbols
      .filter((s) => !bubbleSet.has(s.path))
      .sort((a, b) => cmpPos(a.info.cx, a.info.cy, b.info.cx, b.info.cy))
    for (const s of cands) {
      const { cx, cy } = s.info
      if (frame.inTitleBlock(cx, cy)) continue
      // symbols that hold text are tags, not furniture
      if (raw.texts.some((t) => {
        const c = textCenter(t)
        return c.x > s.info.bbox.minX && c.x < s.info.bbox.maxX && c.y > s.info.bbox.minY && c.y < s.info.bbox.maxY
      })) continue
      if (!roomPolys.some((poly) => pointInPolygon(cx, cy, poly))) continue
      const w = s.info.bbox.maxX - s.info.bbox.minX
      const h = s.info.bbox.maxY - s.info.bbox.minY
      fixtureItems.push({
        id: `fixture-${fixtureItems.length + 1}`,
        kind: 'fixture',
        geometry: pathOf(s.info.pts, true),
        confidence: round3(raw.paths[s.path].filled ? 0.55 : 0.5),
        props: { shape: s.shape, widthPt: round2(w), heightPt: round2(h) },
      })
    }
  }

  // ---- labels ----
  const dimLines = dims.lines
  const labelItems: ContextItem[] = []
  const order = raw.texts.map((t, i) => i).filter((i) => raw.texts[i].text.trim().length > 0)
  order.sort((a, b) => cmpPos(raw.texts[a].x, raw.texts[a].y, raw.texts[b].x, raw.texts[b].y))
  for (const i of order) {
    const t = raw.texts[i]
    const c = textCenter(t)
    const text = t.text.trim()
    let role = 'text'
    let conf = 0.9
    if (frame.inTitleBlock(c.x, c.y)) role = 'titleblock'
    else if (gridTextIdx.has(i)) role = 'grid'
    else if (isNumericDim(text) && nearDim(c, t.height, dimLines)) role = 'dimension'
    else if (isRoomLabel(text)) {
      role = 'room'
      conf = 0.75
    }
    labelItems.push({
      id: `label-${labelItems.length + 1}`,
      kind: 'label',
      geometry: pathOf(
        [
          { x: t.x, y: t.y - t.height },
          { x: t.x + t.width, y: t.y - t.height },
          { x: t.x + t.width, y: t.y },
          { x: t.x, y: t.y },
        ],
        true,
      ),
      text,
      confidence: conf,
      props: { role },
    })
  }

  items.push(...gridItems, ...wallItems, ...openingItems, ...fixtureItems, ...roomItems, ...labelItems)
  const ctx: SheetContext = { sheetId: raw.sheetId, origin: 'inferred', items }
  if (scale !== undefined) ctx.scale = scale
  return ctx
}

/** Thin closed rect outline (candidate fixture). */
function isThinOutline(info: PathInfo, lo: number, hi: number): boolean {
  const thin = Math.min(info.w!, info.h!)
  const long = Math.max(info.w!, info.h!)
  return thin >= lo && thin <= hi && long >= 3 * thin
}

/** True if another path (not in `ignore`) starts or ends on a corner of the rectangle. */
function touchedByOthers(info: PathInfo, paths: RawPath[], self: number, ignore: Set<number>): boolean {
  for (let k = 0; k < paths.length; k++) {
    if (k === self || ignore.has(k)) continue
    const q = paths[k].points
    if (q.length < 2) continue
    for (const e of [q[0], q[q.length - 1]]) for (const c of info.pts) if (Math.abs(e.x - c.x) <= 2 && Math.abs(e.y - c.y) <= 2) return true
  }
  return false
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function nearDim(c: Point, h: number, lines: Array<{ ax: number; ay: number; bx: number; by: number }>): boolean {
  for (const l of lines) {
    const len = hyp(l.bx - l.ax, l.by - l.ay)
    if (len < 1e-9) continue
    const ux = (l.bx - l.ax) / len
    const uy = (l.by - l.ay) / len
    const along = (c.x - l.ax) * ux + (c.y - l.ay) * uy
    const off = Math.abs((c.x - l.ax) * -uy + (c.y - l.ay) * ux)
    if (along >= -8 && along <= len + 8 && off <= 14 + h) return true
  }
  return false
}
