/**
 * `pnpm eval` — replays the stroke corpora through core/predict, headless.
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
 * Corpora: by default every one of fixtures/strokes and fixtures/strokes-indep that exists,
 * each fixtures/<corpus>/**\/*.json a StrokeRecording (or an array of them).
 * The gated metrics (top-1, wrong element, flips, first-hypothesis latency) are computed over the
 * COMBINED held-out set of all corpora; a per-corpus breakdown is printed and stored in `perCorpus`.
 * Context: fixtures/contexts/<pdf-basename>.<sheet>.json (or <pdf>.<sheet>.json,
 * a SheetContext) if present, otherwise an empty shape-only context.
 *
 * Flags (for tuning; AGENTS.md: held-out recordings are never used for tuning):
 *   --corpus=<dir>    replay only that corpus directory; writes reports/eval-<dirname>[-train].json
 *   --split=train     replay only the train split, score everything on it; writes reports/eval-train.json
 *                     (reports/eval.json, which the budgets read, is left untouched)
 *   --verbose         print every misread stroke and every stroke whose leading guess flipped (never held-out ones)
 *
 * Writes reports/eval.json: { metrics: {...budget keys}, perCorpus, confusion, perKind, ... }.
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
const args = process.argv.slice(2)
// --corpus=<dir>: replay only that corpus directory.
const CORPUS_ARG = args.find((a) => a.startsWith('--corpus='))?.slice('--corpus='.length)
const DEFAULT_CORPORA = [resolve(root, 'fixtures', 'strokes'), resolve(root, 'fixtures', 'strokes-indep')]
const CORPUS_DIRS = CORPUS_ARG ? [resolve(CORPUS_ARG)] : DEFAULT_CORPORA.filter((d) => existsSync(d))
const CONTEXTS_DIR = resolve(root, 'fixtures', 'contexts')
// BRUSH_EVAL_ENTRY overrides the entry module path (for trying alternative predictors).
const ENTRY = process.env.BRUSH_EVAL_ENTRY ? resolve(process.env.BRUSH_EVAL_ENTRY) : resolve(root, 'src', 'core', 'predict', 'eval-entry.ts')

const splitArg = args.find((a) => a.startsWith('--split='))?.slice('--split='.length)
if (splitArg !== undefined && splitArg !== 'train') {
  console.error(`--split=${splitArg} is not supported: only --split=train (held-out is scored by plain \`pnpm eval\`).`)
  process.exit(2)
}
const TRAIN_ONLY = splitArg === 'train'
const VERBOSE = args.includes('--verbose')
const OUT = resolve(
  root,
  'reports',
  CORPUS_ARG ? `eval-${basename(resolve(CORPUS_ARG))}${TRAIN_ONLY ? '-train' : ''}.json` : TRAIN_ONLY ? 'eval-train.json' : 'eval.json',
)

const INDEX_FILES = new Set(['index.json', 'manifest.json'])

type Flushable = Predictor & { flush?: (stroke: Stroke, ctx: SheetContext, settings: BrushSettings) => Hypothesis }

interface EvalEntry {
  predictorName?: string
  createPredictor: () => Flushable
  settings?: Partial<BrushSettings>
}

interface LoadedRecording {
  file: string
  corpus: string
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

function loadCorpora(): { recs: LoadedRecording[]; skipped: string[] } {
  const recs: LoadedRecording[] = []
  const skipped: string[] = []
  for (const dir of CORPUS_DIRS) {
    const corpus = basename(dir)
    for (const f of walk(dir)) {
      const rel = relative(root, f).replace(/\\/g, '/')
      try {
        const json = JSON.parse(readFileSync(f, 'utf8')) as unknown
        const list = Array.isArray(json) ? json : [json]
        for (const r of list as StrokeRecording[]) {
          if (r && Array.isArray(r.points) && r.label && DECISION_KINDS.includes(r.label.kind)) recs.push({ file: rel, corpus, rec: r })
          else if (!skipped.includes(rel)) skipped.push(rel)
        }
      } catch {
        skipped.push(rel)
      }
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
  corpus: string
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
function replay(entry: EvalEntry, settings: BrushSettings, { file, corpus, rec }: LoadedRecording): StrokeResult {
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
    corpus,
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
const wrongRate = (rs: StrokeResult[]): number => (rs.length ? rs.filter((r) => r.predicted !== 'markup' && r.predicted !== r.label).length / rs.length : NaN)
const flipsOf = (rs: StrokeResult[]): number => (rs.length ? rs.reduce((a, r) => a + r.flips, 0) / rs.length : NaN)

function confusionOf(rs: StrokeResult[]): Record<string, Record<string, number>> {
  const c: Record<string, Record<string, number>> = {}
  for (const l of DECISION_KINDS) c[l] = Object.fromEntries(DECISION_KINDS.map((p) => [p, 0]))
  for (const r of rs) c[r.label][r.predicted]++
  return c
}

function printConfusion(title: string, c: Record<string, Record<string, number>>) {
  console.log(`\n${title} (rows = label, cols = predicted)`)
  console.log('label'.padEnd(10) + DECISION_KINDS.map((k) => k.padStart(10)).join(''))
  for (const l of DECISION_KINDS) console.log(l.padEnd(10) + DECISION_KINDS.map((p) => String(c[l][p]).padStart(10)).join(''))
}

const pctS = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-')

async function main() {
  const loaded = loadCorpora()
  const recs = TRAIN_ONLY ? loaded.recs.filter((r) => (r.rec.split ?? 'train') === 'train') : loaded.recs
  const skipped = loaded.skipped
  const corpora = [...new Set(recs.map((r) => r.corpus))]
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
    corpora,
    corpus: { total: recs.length, heldout: heldoutCount, byKind, skippedFiles: skipped },
    metrics: {},
  }

  console.log(
    `Corpora: ${corpora.join(', ') || '(none)'} — ${recs.length} recordings (${heldoutCount} held out)${TRAIN_ONLY ? ' [--split=train: tuning run, held-out excluded]' : ''}`,
  )
  console.log('  by kind: ' + DECISION_KINDS.map((k) => `${k}=${byKind[k]}`).join(' '))
  if (skipped.length) console.log(`  skipped ${skipped.length} unreadable file(s)`)

  if (!entry) {
    console.log('\nno predictor yet (src/core/predict/eval-entry.ts missing) — metrics pending (M3)')
  } else if (!recs.length) {
    console.log(`\npredictor "${report.predictor}" found but the corpus is empty — metrics pending`)
  } else {
    const settings: BrushSettings = { ...DEFAULT_BRUSH_SETTINGS, ...(entry.settings ?? {}) }
    const results = recs.map((r) => replay(entry!, settings, r))
    // Gated metrics are judged on the combined held-out set when it exists (spec), else on everything replayed.
    const isScored = (r: StrokeResult) => heldoutCount === 0 || r.split === 'heldout'
    const scored = results.filter(isScored)
    const basis = heldoutCount > 0 ? `heldout (${corpora.join(' + ')})` : TRAIN_ONLY ? 'train (tuning run)' : 'all (no held-out split yet)'
    const firsts = scored.map((r) => r.firstMs).filter(Number.isFinite)
    const allUpdates = results.flatMap((r) => r.updateMs)
    // Refresh rate at the recordings' original timing: hypotheses per second of stroke time
    // (the throttle is by stroke time, so this is what the user sees when updates are fast enough).
    const timed = results.filter((r) => r.durationMs > 0)
    const refreshPerSec = timed.reduce((a, r) => a + r.runs, 0) / (timed.reduce((a, r) => a + r.durationMs, 0) / 1000)
    const ambScored = scored.filter((r) => r.ambiguous)
    const ambAll = results.filter((r) => r.ambiguous)

    const perKind = Object.fromEntries(
      DECISION_KINDS.map((k) => {
        const rs = scored.filter((r) => r.label === k)
        return [k, { n: rs.length, accuracy: rs.length ? rs.filter((r) => r.predicted === k).length / rs.length : null }]
      }),
    )
    const perCorpus = Object.fromEntries(
      corpora.map((c) => {
        const all = results.filter((r) => r.corpus === c)
        const sc = all.filter(isScored)
        return [
          c,
          {
            n: sc.length,
            top1Accuracy: acc(sc),
            wrongElementRate: wrongRate(sc),
            flipsPerStrokeMean: flipsOf(sc),
            firstHypothesisP95Ms: pct(sc.map((r) => r.firstMs).filter(Number.isFinite), 0.95),
            top1AccuracyAll: acc(all),
            wrongElementRateAll: wrongRate(all),
            flipsPerStrokeMeanAll: flipsOf(all),
            confusion: confusionOf(sc),
          },
        ]
      }),
    )

    report.metrics = {
      top1Accuracy: acc(scored),
      top1Basis: basis,
      scoredN: scored.length,
      wrongElementRate: wrongRate(scored),
      flipsPerStrokeMean: flipsOf(scored),
      firstHypothesisP50Ms: pct(firsts, 0.5),
      firstHypothesisP95Ms: pct(firsts, 0.95),
      top1AccuracyAll: acc(results),
      wrongElementRateAll: wrongRate(results),
      flipsPerStrokeMeanAll: flipsOf(results),
      updateP95Ms: pct(allUpdates, 0.95),
      updateMaxMs: Math.max(...allUpdates),
      hypothesisRefreshPerSec: refreshPerSec,
      refreshGapMaxMs: Math.max(...results.map((r) => r.maxGapMs)),
      ambiguousTop1Accuracy: acc(ambScored),
      ambiguousN: ambScored.length,
      ambiguousTop1AccuracyAll: acc(ambAll),
      ambiguousNAll: ambAll.length,
    }
    report.perCorpus = perCorpus
    report.contexts = [...contextFiles].sort()
    report.confusion = confusionOf(results)
    report.confusionScored = confusionOf(scored)
    report.perKind = perKind
    report.strokes = results.map(({ updateMs: _u, ...r }) => r)

    const m = report.metrics as Record<string, number>
    console.log(`\nPredictor: ${report.predictor}   contexts loaded: ${contextFiles.size}`)
    console.log(`Gated metrics on ${basis}, n=${scored.length}:`)
    console.log(`  top-1 ${pctS(m.top1Accuracy)}   wrong element ${pctS(m.wrongElementRate)}   flips/stroke ${m.flipsPerStrokeMean.toFixed(2)}`)
    console.log(`  first hypothesis p50/p95: ${m.firstHypothesisP50Ms.toFixed(2)} / ${m.firstHypothesisP95Ms.toFixed(2)} ms`)
    console.log(`All replayed strokes: top-1 ${pctS(m.top1AccuracyAll)}   wrong element ${pctS(m.wrongElementRateAll)}   flips/stroke ${m.flipsPerStrokeMeanAll.toFixed(2)}`)
    console.log(`Ambiguous subset: ${pctS(m.ambiguousTop1Accuracy)} of ${ambScored.length} (gated basis)   ${pctS(m.ambiguousTop1AccuracyAll)} of ${ambAll.length} (all)`)
    console.log(`Update p95/max: ${m.updateP95Ms.toFixed(2)} / ${m.updateMaxMs.toFixed(2)} ms   refresh at original timing: ${refreshPerSec.toFixed(1)}/s (max gap ${m.refreshGapMaxMs.toFixed(0)} ms)`)
    console.log('\nPer corpus (gated basis | all replayed):')
    for (const c of corpora) {
      const pc = perCorpus[c] as unknown as Record<string, number>
      console.log(
        `  ${c.padEnd(16)} n=${String(pc.n).padStart(3)}  top-1 ${pctS(pc.top1Accuracy).padStart(6)}  wrong ${pctS(pc.wrongElementRate).padStart(5)}  flips ${pc.flipsPerStrokeMean.toFixed(2)}` +
          `  | top-1 ${pctS(pc.top1AccuracyAll).padStart(6)}  wrong ${pctS(pc.wrongElementRateAll).padStart(5)}  flips ${pc.flipsPerStrokeMeanAll.toFixed(2)}`,
      )
    }
    for (const c of corpora) printConfusion(`Confusion, ${c}, ${heldoutCount > 0 ? 'held-out' : 'replayed'}`, (perCorpus[c] as { confusion: Record<string, Record<string, number>> }).confusion)
    if (VERBOSE) {
      console.log('\nMisread or flipping strokes:')
      for (const r of results) {
        if (r.split === 'heldout') continue // never print held-out details (no tuning on them)
        if (r.predicted !== r.label || r.flips > 1)
          console.log(`  ${r.file.padEnd(46)} ${r.label.padEnd(9)} -> ${r.predicted.padEnd(9)} conf ${r.confidence.toFixed(2)} flips ${r.flips} ${r.ambiguous ? 'AMB ' : ''}[${r.path}]`)
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
