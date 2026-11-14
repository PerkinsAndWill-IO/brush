import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ContextItem, Point, RawPageContent, SheetContext } from '../../../src/core/types'

export const root = resolve(import.meta.dirname, '..', '..', '..')

export interface TruthSheet {
  pageIndex: number
  scale: string
  walls: Array<{ id: string; centerline: [Point, Point]; thicknessPt: number }>
  openings: Array<{ id: string; at: Point; widthPt: number; kind: string }>
  grids: Array<{ id: string; label: string; line: [Point, Point] }>
  labels: Array<{ text: string; at: Point }>
  rooms: Array<{ label: string; polygon: Point[] }>
  distractors: {
    dimensions: Array<{ line: [Point, Point] }>
    hatches: Array<{ bbox?: { x: number; y: number; w: number; h: number }; [k: string]: unknown }>
    titleBlock: { x: number; y: number; w: number; h: number }
  }
}

export const PDFS = ['office-1-sheet.pdf', 'office-6-sheets.pdf', 'scanned-1-sheet.pdf']

export function truthFor(pdf: string): TruthSheet[] {
  const base = pdf.replace(/\.pdf$/, '')
  return (JSON.parse(readFileSync(resolve(root, 'fixtures', 'pdfs', `${base}.truth.json`), 'utf8')) as { sheets: TruthSheet[] }).sheets
}

export function rawFor(pdf: string, page: number): RawPageContent | null {
  const f = resolve(root, 'fixtures', 'contexts', `${pdf}.${page}.raw.json`)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as RawPageContent) : null
}

export function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Fraction of segment a-b (sampled every 1 pt) lying within tol of any of the target segments. */
export function coverage(a: Point, b: Point, targets: Array<[Point, Point]>, tol: number): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const n = Math.max(2, Math.ceil(len))
  let hit = 0
  for (let i = 0; i <= n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }
    if (targets.some(([c, d]) => distToSeg(p, c, d) <= tol)) hit++
  }
  return hit / (n + 1)
}

function segsOf(item: ContextItem): Array<[Point, Point]> {
  const pts = item.geometry.points
  const out: Array<[Point, Point]> = []
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]])
  return out
}

export interface Score {
  wallRecall: number
  wallPrecision: number
  gridRecall: number
  gridLabelCorrect: number
  labelRecall: number
  openingRecall: number
  scaleOk: boolean
  wallsOnDistractors: number
  missedWalls: string[]
  falseWalls: string[]
}

function inBox(p: Point, b: { x: number; y: number; w: number; h: number }, pad = 0): boolean {
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad
}

export function score(ctx: SheetContext, truth: TruthSheet, tol = 4, minOverlap = 0.7): Score {
  const walls = ctx.items.filter((i) => i.kind === 'wall')
  const wallSegs = walls.flatMap(segsOf)
  const missedWalls: string[] = []
  let found = 0
  for (const tw of truth.walls) {
    const [a, b] = tw.centerline
    if (coverage(a, b, wallSegs, tol) >= minOverlap) found++
    else missedWalls.push(tw.id)
  }
  const truthSegs = truth.walls.map((w) => w.centerline)
  const falseWalls: string[] = []
  let good = 0
  for (const w of walls) {
    const segs = segsOf(w)
    const len = segs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0)
    const cov = segs.reduce((s, [a, b]) => s + coverage(a, b, truthSegs, tol) * Math.hypot(b.x - a.x, b.y - a.y), 0)
    if (len > 0 && cov / len >= minOverlap) good++
    else falseWalls.push(`${w.id}@${Math.round(w.geometry.points[0].x)},${Math.round(w.geometry.points[0].y)}`)
  }
  const grids = ctx.items.filter((i) => i.kind === 'grid')
  let gridFound = 0
  let gridLabel = 0
  for (const g of truth.grids) {
    const m = grids.find((i) => coverage(g.line[0], g.line[1], segsOf(i), tol) >= minOverlap)
    if (m) {
      gridFound++
      if ((m.text ?? m.props?.label) === g.label) gridLabel++
    }
  }
  const labels = ctx.items.filter((i) => i.kind === 'label')
  const lfound = truth.labels.filter((l) => labels.some((i) => i.text === l.text)).length
  const openings = ctx.items.filter((i) => i.kind === 'opening')
  const ofound = truth.openings.filter((o) =>
    openings.some((i) => {
      const pts = i.geometry.points
      const c = { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2 }
      return Math.hypot(c.x - o.at.x, c.y - o.at.y) <= Math.max(8, o.widthPt * 0.4)
    }),
  ).length
  // walls lying on a dimension line, hatch box or the title block
  let onDistractor = 0
  const dims = truth.distractors.dimensions.map((d) => d.line)
  for (const w of walls) {
    const mid = w.geometry.points[0]
    const segs = segsOf(w)
    const onDim = segs.some(([a, b]) => coverage(a, b, dims, 1.5) > 0.5)
    const tb = truth.distractors.titleBlock
    const onTb = !!tb && segs.some(([a, b]) => inBox({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, tb))
    const onHatch = truth.distractors.hatches.some((h) => h.bbox && inBox(mid, h.bbox))
    if (onDim || onTb || onHatch) onDistractor++
  }
  const nz = (a: number, b: number) => (b === 0 ? 1 : a / b)
  return {
    wallRecall: nz(found, truth.walls.length),
    wallPrecision: nz(good, walls.length),
    gridRecall: nz(gridFound, truth.grids.length),
    gridLabelCorrect: nz(gridLabel, truth.grids.length),
    labelRecall: nz(lfound, truth.labels.length),
    openingRecall: nz(ofound, truth.openings.length),
    scaleOk: ctx.scale === 100,
    wallsOnDistractors: onDistractor,
    missedWalls,
    falseWalls,
  }
}
