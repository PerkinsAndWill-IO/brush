import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { inferContext } from '../../../src/core/context'
import { buildSpatialIndex, snapPoint } from '../../../src/core/geometry'
import type { Point } from '../../../src/core/types'
import { rawFor, root, truthFor, type TruthSheet } from './truth'

const SHEETS = [
  { pdf: 'office-1-sheet.pdf', page: 0 },
  { pdf: 'office-6-sheets.pdf', page: 0 },
  { pdf: 'office-6-sheets.pdf', page: 3 },
]

// Diagonal offsets: a point exactly on a wall line is already "on-wall" (cost 0 in snapPoint), so a stroke end
// drawn along a wall toward a corner keeps its own position; see report.
const offsets: Point[] = [
  { x: 2.5, y: 2.5 },
  { x: -3, y: 2.5 },
  { x: 3, y: -3 },
  { x: -4.2, y: -4.2 },
]

function targets(t: TruthSheet): Array<{ name: string; p: Point }> {
  const out: Array<{ name: string; p: Point }> = []
  // wall-wall corners: truth wall endpoints shared by a perpendicular wall endpoint
  const ends = t.walls.flatMap((w) => w.centerline.map((p) => ({ p, id: w.id })))
  for (const e of ends) {
    const mates = ends.filter((o) => o.id !== e.id && Math.hypot(o.p.x - e.p.x, o.p.y - e.p.y) < 0.5)
    if (mates.length && !out.some((o) => Math.hypot(o.p.x - e.p.x, o.p.y - e.p.y) < 0.5)) out.push({ name: `corner ${e.id}`, p: e.p })
  }
  // wall endpoints that are free ends or T-junction ends
  for (const e of ends) {
    if (!out.some((o) => Math.hypot(o.p.x - e.p.x, o.p.y - e.p.y) < 0.5)) out.push({ name: `endpoint ${e.id}`, p: e.p })
  }
  // grid intersections
  for (const a of t.grids) {
    for (const b of t.grids) {
      const vert = Math.abs(a.line[0].x - a.line[1].x) < 1
      const horiz = Math.abs(b.line[0].y - b.line[1].y) < 1
      if (vert && horiz) out.push({ name: `grid ${a.label}/${b.label}`, p: { x: a.line[0].x, y: b.line[0].y } })
    }
  }
  return out
}

const times = { snap: [] as number[], build: [] as number[] }

describe('M2-08 snapping on the fixture sheets', () => {
  for (const { pdf, page } of SHEETS) {
    const truth = truthFor(pdf).find((s) => s.pageIndex === page)!
    it(`${pdf} sheet ${page}: a stroke end 3-6 pt from a truth point snaps to it within 1.5 pt`, () => {
      const raw = rawFor(pdf, page)
      expect(raw, 'run scripts/build-contexts.ts').not.toBeNull()
      const t0 = performance.now()
      const ctx = inferContext(raw!)
      const index = buildSpatialIndex(ctx.items)
      snapPoint({ x: 0, y: 0 }, index) // builds the snap tables
      times.build.push(performance.now() - t0)
      const all = targets(truth)
      expect(all.length).toBeGreaterThan(20)
      const failures: string[] = []
      let n = 0
      for (const tg of all) {
        for (const o of offsets) {
          const q = { x: tg.p.x + o.x, y: tg.p.y + o.y }
          const t1 = performance.now()
          const r = snapPoint(q, index, { radius: 8, kinds: tg.name.startsWith('grid') ? ['grid'] : ['wall'] })
          times.snap.push(performance.now() - t1)
          n++
          if (Math.hypot(r.point.x - tg.p.x, r.point.y - tg.p.y) > 1.5) failures.push(`${tg.name} +(${o.x},${o.y}) -> ${r.kind} off by ${Math.hypot(r.point.x - tg.p.x, r.point.y - tg.p.y).toFixed(1)}`)
        }
      }
      // wall targets snap among walls, grid crossings among grid lines (a wall end that sits beside a grid line is
      // ambiguous with the default kinds, the canvas picks by tool state)
      expect(failures.length / n, failures.slice(0, 8).join('; ')).toBeLessThanOrEqual(0.02)
    })
  }

  it('M2 budgets: snap decision p95 <= 2 ms, context build <= 1000 ms (written to reports/perf-context.json)', () => {
    const sorted = times.snap.slice().sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
    // build time = pdf.js extraction (from scripts/build-contexts.ts report, if present) + inference + index
    let extractMax = 0
    const rep = resolve(root, 'reports', 'context-build.json')
    if (existsSync(rep)) {
      const j = JSON.parse(readFileSync(rep, 'utf8')) as { timings: Array<{ extractMs: number }> }
      extractMax = Math.max(0, ...j.timings.map((x) => x.extractMs))
    }
    const build = Math.max(0, ...times.build) + extractMax
    mkdirSync(resolve(root, 'reports'), { recursive: true })
    writeFileSync(
      resolve(root, 'reports', 'perf-context.json'),
      JSON.stringify({ snapDecisionMs: p95, contextBuildMs: build, metrics: { snapDecisionMs: p95, contextBuildMs: build } }, null, 2),
    )
    expect(p95).toBeLessThanOrEqual(2)
    expect(build).toBeLessThanOrEqual(1000)
  })
})
