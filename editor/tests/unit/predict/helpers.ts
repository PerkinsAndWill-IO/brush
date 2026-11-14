import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BRUSH_SETTINGS,
  type BrushSettings,
  type ContextItem,
  type Hypothesis,
  type Point,
  type SheetContext,
  type Stroke,
  type StrokePoint,
  type StrokeRecording,
} from '../../../src/core/types'
import { StreamingPredictor } from '../../../src/core/predict'

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')

export const settings = (over: Partial<BrushSettings> = {}): BrushSettings => ({ ...DEFAULT_BRUSH_SETTINGS, ...over })

/** 1:100 → 28.35 pt per metre. */
export const PT_PER_M = (1000 / 100 / 25.4) * 72

const wall = (id: string, a: Point, b: Point): ContextItem => ({
  id,
  kind: 'wall',
  geometry: { points: [a, b], closed: false },
  confidence: 0.9,
  props: { thicknessPt: '7' },
})

/**
 * Hand-built sheet:  wall-h along y=100 (x 0..600), wall-v along x=300 (y 0..400),
 * room MEETING 101 = (0,100)-(300,400), fixture-1 = 40x20 box at (100,200), label OFFICE 7 at (420,300).
 */
export function testContext(): SheetContext {
  return {
    sheetId: 'sheet-0',
    origin: 'inferred',
    scale: 100,
    items: [
      wall('wall-h', { x: 0, y: 100 }, { x: 600, y: 100 }),
      wall('wall-v', { x: 300, y: 0 }, { x: 300, y: 400 }),
      {
        id: 'room-1',
        kind: 'unknown',
        geometry: { points: [{ x: 0, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 400 }, { x: 0, y: 400 }], closed: true },
        confidence: 0.8,
        props: { role: 'room', label: 'MEETING 101' },
      },
      {
        id: 'fixture-1',
        kind: 'fixture',
        geometry: { points: [{ x: 100, y: 200 }, { x: 140, y: 200 }, { x: 140, y: 220 }, { x: 100, y: 220 }], closed: true },
        confidence: 0.8,
        props: { shape: 'rect' },
      },
      {
        id: 'label-1',
        kind: 'label',
        text: 'OFFICE 7',
        geometry: { points: [{ x: 420, y: 300 }, { x: 460, y: 300 }, { x: 460, y: 307 }, { x: 420, y: 307 }], closed: true },
        confidence: 0.9,
        props: { role: 'room' },
      },
    ],
  }
}

export const scannedContext = (): SheetContext => ({ sheetId: 'sheet-0', origin: 'inferred', items: [], shapeOnly: true })

/** Densify a polyline into stroke points, ~`step` pt apart, `dt` ms apart, starting at t = 0. */
export function polyStroke(verts: Point[], opts: { step?: number; dt?: number; tool?: Stroke['tool']; id?: string; startedAt?: number } = {}): Stroke {
  const step = opts.step ?? 2.5
  const dt = opts.dt ?? 8
  const pts: StrokePoint[] = []
  let t = 0
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i]
    const b = verts[i + 1]
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step))
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, t, p: 0.5 })
      t += dt
    }
  }
  const s: Stroke = { id: opts.id ?? 'test-stroke', sheetId: 'sheet-0', points: pts, tool: opts.tool ?? 'brush', size: 2 }
  if (opts.startedAt !== undefined) s.startedAt = opts.startedAt
  return s
}

/** Closed axis-aligned rectangle stroke. */
export const rectStroke = (x: number, y: number, w: number, h: number): Stroke =>
  polyStroke([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y: y + 0.5 }])

/** Zig-zag scribble across a box. */
export function scribbleStroke(x: number, y: number, w: number, h: number, zigs = 8, tool: Stroke['tool'] = 'brush'): Stroke {
  const v: Point[] = []
  for (let i = 0; i <= zigs; i++) v.push({ x: i % 2 === 0 ? x : x + w, y: y + (h * i) / zigs })
  return polyStroke(v, { tool })
}

/** Feed a stroke point by point through update() (as the canvas would) and flush at the end. */
export function replayStroke(stroke: Stroke, ctx: SheetContext, s: BrushSettings, p = new StreamingPredictor()): { predictor: StreamingPredictor; final: Hypothesis } {
  const acc: Stroke = { ...stroke, points: [] }
  for (const pt of stroke.points) {
    acc.points.push(pt)
    p.update({ ...acc, points: acc.points.slice() }, ctx, s)
  }
  return { predictor: p, final: p.flush(stroke, ctx, s) }
}

/**
 * Train-split recordings with their contexts, about `limit` in total spread evenly over the
 * five kinds (held-out recordings are never loaded by unit tests).
 */
export function trainRecordings(limit = Infinity): { file: string; rec: StrokeRecording; ctx: SheetContext }[] {
  const out: { file: string; rec: StrokeRecording; ctx: SheetContext }[] = []
  const dir = join(ROOT, 'fixtures', 'strokes')
  const perKind = Math.ceil(limit / 5)
  for (const kind of ['wall', 'door', 'furniture', 'delete', 'markup']) {
    const kd = join(dir, kind)
    if (!existsSync(kd)) continue
    let n = 0
    for (const f of readdirSync(kd).sort()) {
      if (n >= perKind) break
      const rec = JSON.parse(readFileSync(join(kd, f), 'utf8')) as StrokeRecording
      if (rec.split === 'heldout') continue
      const base = rec.pdf.replace(/\.pdf$/, '')
      const p = [join(ROOT, 'fixtures', 'contexts', `${base}.${rec.sheet}.json`), join(ROOT, 'fixtures', 'contexts', `${rec.pdf}.${rec.sheet}.json`)].find(existsSync)
      const ctx: SheetContext = p ? (JSON.parse(readFileSync(p, 'utf8')) as SheetContext) : scannedContext()
      out.push({ file: `${kind}/${f}`, rec, ctx })
      n++
    }
  }
  return out
}

/** Replay a recording on the harness cadence (first point, every refreshMs of stroke time, last point via flush). */
export function replayRecording(rec: StrokeRecording, ctx: SheetContext, s: BrushSettings): Hypothesis[] {
  const p = new StreamingPredictor()
  const stroke: Stroke = { id: 'rec', sheetId: ctx.sheetId, points: [], tool: rec.tool ?? 'brush', size: 2 }
  let lastT = -Infinity
  rec.points.forEach((pt, i) => {
    stroke.points.push(pt)
    const last = i === rec.points.length - 1
    if (i === 0 || pt.t - lastT >= s.refreshMs || last) {
      lastT = pt.t
      const snap = { ...stroke, points: stroke.points.slice() }
      if (last && i > 0) p.flush(snap, ctx, s)
      else p.update(snap, ctx, s)
    }
  })
  return p.hypotheses
}
