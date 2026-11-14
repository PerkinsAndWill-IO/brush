/**
 * `pnpm eval` — replays the stroke corpus through core/predict, headless.
 *
 * Plug-in point (see docs/tasks/eval-entry.md): if src/core/predict/eval-entry.ts
 * exists it must export
 *   predictorName: string
 *   createPredictor(): Predictor            // fresh instance per stroke
 *   settings?: Partial<BrushSettings>       // optional overrides of DEFAULT_BRUSH_SETTINGS
 * The harness owns replay, timing and scoring so the numbers stay honest.
 * If the predictor also has `flush(stroke, ctx, settings)`, it is called on the
 * last point instead of `update` (the committed hypothesis on the full stroke).
 *
 * Corpus: fixtures/strokes/**\/*.json, each a StrokeRecording (or an array of them).
 * Context: fixtures/contexts/<pdf-basename>.<sheet>.json (or <pdf>.<sheet>.json,
 * a SheetContext) if present, otherwise an empty shape-only context.
 *
 * Flags (for tuning; AGENTS.md: held-out recordings are never used for tuning):
 *   --split=train     replay only the train split, score everything on it, write reports/eval-train.json
 *                     (reports/eval.json, which the budgets read, is left untouched)
 *   --verbose         print every misread stroke and every stroke whose leading guess flipped
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

const args = process.argv.slice(2)
const splitArg = args.find((a) => a.startsWith('--split='))?.slice('--split='.length)
if (splitArg !== undefined && splitArg !== 'train') {
  console.error(`--split=${splitArg} is not supported: only --split=train (held-out is scored by plain \`pnpm eval\`).`)
  process.exit(2)
}
const TRAIN_ONLY = splitArg === 'train'
const VERBOSE = args.includes('--verbose')
const OUT = resolve(root, 'reports', TRAIN_ONLY ? 'eval-train.json' : 'eval.json')

const INDEX_FILES = new Set(['index.json', 'manifest.json'])

type Flushable = Predictor & { flush?: (stroke: Stroke, ctx: SheetContext, settings: BrushSettings) => Hypothesis }

interface EvalEntry {
  predictorName?: string
  createPredictor: () => Flushable
  settings?: Partial<BrushSettings>
}

interface LoadedRecording {
  file: string
  rec: StrokeRecording
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
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
const contextFiles = new Set<string>()
function contextFor(rec: StrokeRecording, sheetId: string): SheetContext {
  const key = `${basename(rec.pdf, '.pdf')}.${rec.sheet}`
  const cached = contextCache.get(key)
  if (cached) return cached
  // accept both <pdf-basename>.<sheet>.json and <pdf-file-name>.<sheet>.json
  const p = [join(CONTEXTS_DIR, `${key}.json`), join(CONTEXTS_DIR, `${rec.pdf}.${rec.sheet}.json`)].find((x) => existsSync(x))
  const ctx: SheetContext = p
    ? (JSON.parse(readFileSync(p, 'utf8')) as SheetContext)
    : { sheetId, origin: 'inferred', items: [], shapeOnly: true }
  if (p) contextFiles.add(relative(root, p).replace(/\\/g, '/'))
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
  confidence: number
  split: 'train' | 'heldout'
  ambiguous: boolean
  flips: number
  runs: number
  durationMs: number
  /** Leading kind per run, for --verbose. */
  path: string
  firstMs: number
  updateMs: number[]
  maxGapMs: number
}

/** Replay one recording as fast as possible, calling update() on the engine's refresh cadence (recorded time). */
function replay(entry: EvalEntry, settings: BrushSettings, { file, rec }: LoadedRecording): StrokeResult {
  const sheetId = `sheet-${rec.sheet}`
  const ctx = contextFor(rec, sheetId)
  const predictor = entry.createPredictor()
  const stroke: Stroke = { id: `eval:${file}`, sheetId, points: [], tool: rec.tool ?? 'brush', size: settings.size }
  const updateMs: number[] = []
  const kinds: DecisionKind[] = []
  const runTimes: number[] = []
  let last: Hypothesis | null = null
  let lastRunT = -Infinity
  let flips = 0
  const run = (final: boolean, t: number) => {
    const snapshot = { ...stroke, points: [...stroke.points] }
    const t0 = performance.now()
    const h = final && typeof predictor.flush === 'function' ? predictor.flush(snapshot, ctx, settings) : predictor.update(snapshot, ctx, settings)
    updateMs.push(performance.now() - t0)
    if (last && h.kind !== last.kind) flips++
    last = h
    kinds.push(h.kind)
    runTimes.push(t)
  }
  rec.points.forEach((pt, i) => {
    stroke.points.push(pt)
    const isLast = i === rec.points.length - 1
    if (i === 0 || pt.t - lastRunT >= settings.refreshMs || isLast) {
      lastRunT = pt.t
      run(isLast && i > 0, pt.t)
    }
  })
  const final = last as Hypothesis | null
  const durationMs = rec.points.length ? rec.points[rec.points.length - 1].t - rec.points[0].t : 0
  let maxGapMs = 0
  for (let i = 1; i < runTimes.length; i++) maxGapMs = Math.max(maxGapMs, runTimes[i] - runTimes[i - 1])
  const compact: string[] = []
  for (const k of kinds) if (compact[compact.length - 1] !== k) compact.push(k)
  return {
    file,
    label: rec.label.kind,
    predicted: final?.kind ?? 'markup',
    confidence: final?.confidence ?? 0,
    split: rec.split ?? 'train',
    ambiguous: /^ambiguous/i.test(rec.label.note ?? ''),
    flips,
    runs: updateMs.length,
    durationMs,
    path: compact.join('>'),
    firstMs: updateMs[0] ?? NaN,
    updateMs,
    maxGapMs,
  }
}

const acc = (rs: StrokeResult[]): number => (rs.length ? rs.filter((r) => r.predicted === r.label).length / rs.length : NaN)

async function main() {
  const loaded = loadCorpus()
  const recs = TRAIN_ONLY ? loaded.recs.filter((r) => (r.rec.split ?? 'train') === 'train') : loaded.recs
  const skipped = loaded.skipped
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
    split: TRAIN_ONLY ? 'train' : 'all',
    corpus: { total: recs.length, heldout: heldoutCount, byKind, skippedFiles: skipped },
    metrics: {},
  }

  console.log(`Corpus: ${recs.length} recordings (${heldoutCount} held out) from fixtures/strokes${TRAIN_ONLY ? ' [--split=train: tuning run, held-out excluded]' : ''}`)
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
    const top1Basis = heldoutCount > 0 ? 'heldout' : TRAIN_ONLY ? 'train (tuning run)' : 'all (no held-out split yet)'
    const top1 = acc(scored)
    const wrongElement = results.filter((r) => r.predicted !== 'markup' && r.predicted !== r.label).length / results.length
    const flipsMean = results.reduce((a, r) => a + r.flips, 0) / results.length
    const firsts = results.map((r) => r.firstMs).filter(Number.isFinite)
    const allUpdates = results.flatMap((r) => r.updateMs)
    // Refresh rate at the recordings' original timing: hypotheses per second of stroke time
    // (the throttle is by stroke time, so this is what the user sees when updates are fast enough).
    const timed = results.filter((r) => r.durationMs > 0)
    const refreshPerSec = timed.reduce((a, r) => a + r.runs, 0) / (timed.reduce((a, r) => a + r.durationMs, 0) / 1000)
    const ambScored = scored.filter((r) => r.ambiguous)
    const ambAll = results.filter((r) => r.ambiguous)

    const confusion: Record<string, Record<string, number>> = {}
    for (const l of DECISION_KINDS) confusion[l] = Object.fromEntries(DECISION_KINDS.map((p) => [p, 0]))
    for (const r of results) confusion[r.label][r.predicted]++
    const confusionScored: Record<string, Record<string, number>> = {}
    for (const l of DECISION_KINDS) confusionScored[l] = Object.fromEntries(DECISION_KINDS.map((p) => [p, 0]))
    for (const r of scored) confusionScored[r.label][r.predicted]++

    const perKind = Object.fromEntries(
      DECISION_KINDS.map((k) => {
        const rs = results.filter((r) => r.label === k)
        return [k, { n: rs.length, accuracy: rs.length ? rs.filter((r) => r.predicted === k).length / rs.length : null }]
      }),
    )

    report.metrics = {
      top1Accuracy: top1,
      top1Basis,
      top1AccuracyAll: acc(results),
      wrongElementRate: wrongElement,
      flipsPerStrokeMean: flipsMean,
      firstHypothesisP50Ms: pct(firsts, 0.5),
      firstHypothesisP95Ms: pct(firsts, 0.95),
      updateP95Ms: pct(allUpdates, 0.95),
      updateMaxMs: Math.max(...allUpdates),
      hypothesisRefreshPerSec: refreshPerSec,
      refreshGapMaxMs: Math.max(...results.map((r) => r.maxGapMs)),
      ambiguousTop1Accuracy: acc(ambScored),
      ambiguousN: ambScored.length,
      ambiguousTop1AccuracyAll: acc(ambAll),
      ambiguousNAll: ambAll.length,
    }
    report.contexts = [...contextFiles].sort()
    report.confusion = confusion
    report.confusionScored = confusionScored
    report.perKind = perKind
    report.strokes = results.map(({ updateMs: _u, ...r }) => r)

    const m = report.metrics as Record<string, number>
    console.log(`\nPredictor: ${report.predictor}   contexts loaded: ${contextFiles.size}`)
    console.log(`Top-1 accuracy (${top1Basis}): ${(top1 * 100).toFixed(1)}%   (all strokes: ${(m.top1AccuracyAll * 100).toFixed(1)}%)`)
    console.log(
      `Ambiguous subset: ${(m.ambiguousTop1Accuracy * 100).toFixed(1)}% of ${ambScored.length} (${top1Basis})   ${(m.ambiguousTop1AccuracyAll * 100).toFixed(1)}% of ${ambAll.length} (all)`,
    )
    console.log(`Wrong element committed: ${(wrongElement * 100).toFixed(1)}%   flips/stroke: ${flipsMean.toFixed(2)}`)
    console.log(`First hypothesis p50/p95: ${pct(firsts, 0.5).toFixed(2)} / ${pct(firsts, 0.95).toFixed(2)} ms   update p95/max: ${m.updateP95Ms.toFixed(2)} / ${m.updateMaxMs.toFixed(2)} ms`)
    console.log(`Refresh at original timing: ${refreshPerSec.toFixed(1)} hypotheses/s (max gap ${m.refreshGapMaxMs.toFixed(0)} ms)`)
    const printConfusion = (title: string, c: Record<string, Record<string, number>>) => {
      console.log(`\n${title} (rows = label, cols = predicted)`)
      console.log('label'.padEnd(10) + DECISION_KINDS.map((k) => k.padStart(10)).join(''))
      for (const l of DECISION_KINDS) console.log(l.padEnd(10) + DECISION_KINDS.map((p) => String(c[l][p]).padStart(10)).join(''))
    }
    printConfusion('Confusion, all replayed strokes', confusion)
    if (heldoutCount > 0) printConfusion('Confusion, held-out', confusionScored)
    if (VERBOSE) {
      console.log('\nMisread or flipping strokes:')
      for (const r of results) {
        if (r.split === 'heldout' && !TRAIN_ONLY) continue // never print held-out details (no tuning on them)
        if (r.predicted !== r.label || r.flips > 1)
          console.log(`  ${r.file.padEnd(36)} ${r.label.padEnd(9)} -> ${r.predicted.padEnd(9)} conf ${r.confidence.toFixed(2)} flips ${r.flips} ${r.ambiguous ? 'AMB ' : ''}[${r.path}]`)
      }
    }
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
