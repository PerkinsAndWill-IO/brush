/**
 * `pnpm eval` — replays the stroke corpus through core/predict, headless.
 *
 * Plug-in point (see docs/tasks/eval-entry.md): if src/core/predict/eval-entry.ts
 * exists it must export
 *   predictorName: string
 *   createPredictor(): Predictor            // fresh instance per stroke
 *   settings?: Partial<BrushSettings>       // optional overrides of DEFAULT_BRUSH_SETTINGS
 * The harness owns replay, timing and scoring so the numbers stay honest.
 *
 * Corpus: fixtures/strokes/**\/*.json, each a StrokeRecording (or an array of them).
 * Context: fixtures/contexts/<pdf-basename>.<sheet>.json (a SheetContext) if present,
 * otherwise an empty shape-only context.
 *
 * Writes reports/eval.json: { metrics: {...budget keys}, confusion, perKind, ... }.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  DECISION_KINDS,
  DEFAULT_BRUSH_SETTINGS,
  type BrushSettings,
  type DecisionKind,
  type Hypothesis,
  type Predictor,
  type SheetContext,
  type Stroke,
  type StrokeRecording,
} from '../../src/core/types/index'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const STROKES_DIR = resolve(root, 'fixtures', 'strokes')
const CONTEXTS_DIR = resolve(root, 'fixtures', 'contexts')
// BRUSH_EVAL_ENTRY overrides the entry module path (for trying alternative predictors).
const ENTRY = process.env.BRUSH_EVAL_ENTRY ? resolve(process.env.BRUSH_EVAL_ENTRY) : resolve(root, 'src', 'core', 'predict', 'eval-entry.ts')
const OUT = resolve(root, 'reports', 'eval.json')

const INDEX_FILES = new Set(['index.json', 'manifest.json'])

interface EvalEntry {
  predictorName?: string
  createPredictor: () => Predictor
  settings?: Partial<BrushSettings>
}

interface LoadedRecording {
  file: string
  rec: StrokeRecording
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return walk(p)
    // index.json / manifest.json are corpus listings, not recordings
    return n.endsWith('.json') && !INDEX_FILES.has(n) ? [p] : []
  })
}

function loadCorpus(): { recs: LoadedRecording[]; skipped: string[] } {
  const recs: LoadedRecording[] = []
  const skipped: string[] = []
  for (const f of walk(STROKES_DIR)) {
    const rel = relative(root, f).replace(/\\/g, '/')
    try {
      const json = JSON.parse(readFileSync(f, 'utf8')) as unknown
      const list = Array.isArray(json) ? json : [json]
      for (const r of list as StrokeRecording[]) {
        if (r && Array.isArray(r.points) && r.label && DECISION_KINDS.includes(r.label.kind)) recs.push({ file: rel, rec: r })
        else if (!skipped.includes(rel)) skipped.push(rel)
      }
    } catch {
      skipped.push(rel)
    }
  }
  return { recs, skipped }
}

const contextCache = new Map<string, SheetContext>()
function contextFor(rec: StrokeRecording, sheetId: string): SheetContext {
  const key = `${basename(rec.pdf, '.pdf')}.${rec.sheet}`
  const cached = contextCache.get(key)
  if (cached) return cached
  const p = join(CONTEXTS_DIR, `${key}.json`)
  const ctx: SheetContext = existsSync(p)
    ? (JSON.parse(readFileSync(p, 'utf8')) as SheetContext)
    : { sheetId, origin: 'inferred', items: [], shapeOnly: true }
  contextCache.set(key, ctx)
  return ctx
}

function pct(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

interface StrokeResult {
  file: string
  label: DecisionKind
  predicted: DecisionKind
  split: 'train' | 'heldout'
  flips: number
  runs: number
  firstMs: number
  updateMs: number[]
}

/** Replay one recording as fast as possible, calling update() on the engine's refresh cadence (recorded time). */
function replay(entry: EvalEntry, settings: BrushSettings, { file, rec }: LoadedRecording): StrokeResult {
  const sheetId = `sheet-${rec.sheet}`
  const ctx = contextFor(rec, sheetId)
  const predictor = entry.createPredictor()
  const stroke: Stroke = { id: `eval:${file}`, sheetId, points: [], tool: rec.tool ?? 'brush', size: settings.size }
  const updateMs: number[] = []
  let last: Hypothesis | null = null
  let lastRunT = -Infinity
  let flips = 0
  const run = () => {
    const t0 = performance.now()
    const h = predictor.update({ ...stroke, points: [...stroke.points] }, ctx, settings)
    updateMs.push(performance.now() - t0)
    if (last && h.kind !== last.kind) flips++
    last = h
  }
  rec.points.forEach((pt, i) => {
    stroke.points.push(pt)
    const isLast = i === rec.points.length - 1
    if (i === 0 || pt.t - lastRunT >= settings.refreshMs || isLast) {
      lastRunT = pt.t
      run()
    }
  })
  const final = last as Hypothesis | null
  return {
    file,
    label: rec.label.kind,
    predicted: final?.kind ?? 'markup',
    split: rec.split ?? 'train',
    flips,
    runs: updateMs.length,
    firstMs: updateMs[0] ?? NaN,
    updateMs,
  }
}

async function main() {
  const { recs, skipped } = loadCorpus()
  const byKind = Object.fromEntries(DECISION_KINDS.map((k) => [k, recs.filter((r) => r.rec.label.kind === k).length]))
  const heldoutCount = recs.filter((r) => r.rec.split === 'heldout').length

  let entry: EvalEntry | null = null
  if (existsSync(ENTRY)) {
    const mod = (await import(pathToFileURL(ENTRY).href)) as Partial<EvalEntry>
    if (typeof mod.createPredictor === 'function') entry = mod as EvalEntry
    else console.warn('src/core/predict/eval-entry.ts exists but does not export createPredictor(); treating as no predictor.')
  }

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    predictor: entry ? (entry.predictorName ?? 'unnamed') : null,
    corpus: { total: recs.length, heldout: heldoutCount, byKind, skippedFiles: skipped },
    metrics: {},
  }

  console.log(`Corpus: ${recs.length} recordings (${heldoutCount} held out) from fixtures/strokes`)
  console.log('  by kind: ' + DECISION_KINDS.map((k) => `${k}=${byKind[k]}`).join(' '))
  if (skipped.length) console.log(`  skipped ${skipped.length} unreadable file(s)`)

  if (!entry) {
    console.log('\nno predictor yet (src/core/predict/eval-entry.ts missing) — metrics pending (M3)')
  } else if (!recs.length) {
    console.log(`\npredictor "${report.predictor}" found but the corpus is empty — metrics pending`)
  } else {
    const settings: BrushSettings = { ...DEFAULT_BRUSH_SETTINGS, ...(entry.settings ?? {}) }
    const results = recs.map((r) => replay(entry!, settings, r))
    // Top-1 is judged on the held-out fifth when it exists (spec), else on everything.
    const scored = heldoutCount > 0 ? results.filter((r) => r.split === 'heldout') : results
    const top1 = scored.filter((r) => r.predicted === r.label).length / scored.length
    const wrongElement = results.filter((r) => r.predicted !== 'markup' && r.predicted !== r.label).length / results.length
    const flipsMean = results.reduce((a, r) => a + r.flips, 0) / results.length
    const firsts = results.map((r) => r.firstMs).filter(Number.isFinite)
    const allUpdates = results.flatMap((r) => r.updateMs)

    const confusion: Record<string, Record<string, number>> = {}
    for (const l of DECISION_KINDS) confusion[l] = Object.fromEntries(DECISION_KINDS.map((p) => [p, 0]))
    for (const r of results) confusion[r.label][r.predicted]++

    const perKind = Object.fromEntries(
      DECISION_KINDS.map((k) => {
        const rs = results.filter((r) => r.label === k)
        return [k, { n: rs.length, accuracy: rs.length ? rs.filter((r) => r.predicted === k).length / rs.length : null }]
      }),
    )

    report.metrics = {
      top1Accuracy: top1,
      top1Basis: heldoutCount > 0 ? 'heldout' : 'all (no held-out split yet)',
      wrongElementRate: wrongElement,
      flipsPerStrokeMean: flipsMean,
      firstHypothesisP50Ms: pct(firsts, 0.5),
      firstHypothesisP95Ms: pct(firsts, 0.95),
      updateP95Ms: pct(allUpdates, 0.95),
      updateMaxMs: Math.max(...allUpdates),
    }
    report.confusion = confusion
    report.perKind = perKind
    report.strokes = results.map(({ updateMs: _u, ...r }) => r)

    console.log(`\nPredictor: ${report.predictor}`)
    console.log(`Top-1 accuracy (${(report.metrics as { top1Basis: string }).top1Basis}): ${(top1 * 100).toFixed(1)}%`)
    console.log(`Wrong element committed: ${(wrongElement * 100).toFixed(1)}%   flips/stroke: ${flipsMean.toFixed(2)}`)
    console.log(`First hypothesis p50/p95: ${pct(firsts, 0.5).toFixed(2)} / ${pct(firsts, 0.95).toFixed(2)} ms`)
    console.log('\nConfusion (rows = label, cols = predicted)')
    console.log('label'.padEnd(10) + DECISION_KINDS.map((k) => k.padStart(10)).join(''))
    for (const l of DECISION_KINDS) console.log(l.padEnd(10) + DECISION_KINDS.map((p) => String(confusion[l][p]).padStart(10)).join(''))
  }

  mkdirSync(dirname(OUT), { recursive: true })
  // metrics holds numbers only (budget keys) plus top1Basis string; verify.ts ignores non-numbers.
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${relative(root, OUT)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
