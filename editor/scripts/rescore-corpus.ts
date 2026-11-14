/**
 * Shared by scripts/record-cassettes.ts and tests/eval/run-rescore.ts:
 * load the stroke corpora, replay each recording through the first pass with
 * the same cadence as tests/eval/run-eval.ts, and build the M4 ContextPacket.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { DECISION_KINDS, DEFAULT_BRUSH_SETTINGS, type BrushSettings, type ContextPacket, type DecisionKind, type Hypothesis, type SheetContext, type Stroke, type StrokeRecording } from '../src/core/types/index'
import { StreamingPredictor, buildContextPacket } from '../src/core/predict/index'
import { isCassette, shouldRescore, type AdapterId, type Cassette, type RescoreSettings } from '../src/core/rescore/index'

export interface CorpusStroke {
  file: string
  corpus: string
  rec: StrokeRecording
  label: DecisionKind
  split: 'train' | 'heldout'
  /** label.note starts with "ambiguous" (same test as run-eval.ts). */
  ambiguous: boolean
  stroke: Stroke
  /** First-pass hypothesis on the full stroke (what pen-up shows / commit takes). */
  hypothesis: Hypothesis
  packet: ContextPacket
  /** Stroke time of the last point (pen up), ms since pen-down. */
  penUpMs: number
}

const INDEX_FILES = new Set(['index.json', 'manifest.json'])

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) return walk(p)
      return n.endsWith('.json') && !INDEX_FILES.has(n) ? [p] : []
    })
}

export function corpusDirs(root: string): string[] {
  return [resolve(root, 'fixtures', 'strokes'), resolve(root, 'fixtures', 'strokes-indep')].filter((d) => existsSync(d))
}

export function loadRescoreCorpus(root: string, settings: BrushSettings = DEFAULT_BRUSH_SETTINGS): CorpusStroke[] {
  const contexts = new Map<string, SheetContext>()
  const contextFor = (rec: StrokeRecording, sheetId: string): SheetContext => {
    const key = `${basename(rec.pdf, '.pdf')}.${rec.sheet}`
    const hit = contexts.get(key)
    if (hit) return hit
    const dir = resolve(root, 'fixtures', 'contexts')
    const p = [join(dir, `${key}.json`), join(dir, `${rec.pdf}.${rec.sheet}.json`)].find((x) => existsSync(x))
    const ctx: SheetContext = p ? (JSON.parse(readFileSync(p, 'utf8')) as SheetContext) : { sheetId, origin: 'inferred', items: [], shapeOnly: true }
    contexts.set(key, ctx)
    return ctx
  }
  const out: CorpusStroke[] = []
  for (const dir of corpusDirs(root)) {
    const corpus = basename(dir)
    for (const f of walk(dir)) {
      const file = relative(root, f).replace(/\\/g, '/')
      let list: StrokeRecording[]
      try {
        const json = JSON.parse(readFileSync(f, 'utf8')) as unknown
        list = (Array.isArray(json) ? json : [json]) as StrokeRecording[]
      } catch {
        continue
      }
      list.forEach((rec, i) => {
        if (!rec || !Array.isArray(rec.points) || !rec.label || !DECISION_KINDS.includes(rec.label.kind) || !rec.points.length) return
        const sheetId = `sheet-${rec.sheet}`
        const ctx = contextFor(rec, sheetId)
        const id = list.length > 1 ? `${file}#${i}` : file
        const { stroke, hypothesis, evidence } = replayFirstPass(rec, ctx, settings, `eval:${id}`)
        out.push({
          file: id,
          corpus,
          rec,
          label: rec.label.kind,
          split: rec.split ?? 'train',
          ambiguous: /^ambiguous/i.test(rec.label.note ?? ''),
          stroke,
          hypothesis,
          packet: buildContextPacket({ stroke, ctx, evidence }, hypothesis, []),
          penUpMs: rec.points[rec.points.length - 1].t,
        })
      })
    }
  }
  return out
}

/** Same cadence as run-eval.ts: update() every refreshMs of stroke time, flush() on the last point. */
function replayFirstPass(rec: StrokeRecording, ctx: SheetContext, settings: BrushSettings, id: string) {
  const predictor = new StreamingPredictor()
  const stroke: Stroke = { id, sheetId: `sheet-${rec.sheet}`, points: [], tool: rec.tool ?? 'brush', size: settings.size }
  let lastRunT = -Infinity
  let h: Hypothesis | undefined
  rec.points.forEach((pt, i) => {
    stroke.points.push(pt)
    const isLast = i === rec.points.length - 1
    if (i === 0 || pt.t - lastRunT >= settings.refreshMs || isLast) {
      lastRunT = pt.t
      const snap = { ...stroke, points: [...stroke.points] }
      h = isLast && i > 0 ? predictor.flush(snap, ctx, settings) : predictor.update(snap, ctx, settings)
    }
  })
  return { stroke, hypothesis: h as Hypothesis, evidence: predictor.lastTrace?.evidence }
}

/**
 * Strokes to record: label.note "ambiguous:" in fixtures/strokes, train strokes of
 * fixtures/strokes-indep with first-pass top confidence < 0.6, plus every stroke
 * the ambiguity policy would send to the second pass (so the eval has an answer
 * for each call it makes, held-out included — recording is not tuning).
 */
export function recordSelection(s: CorpusStroke, rs: Pick<RescoreSettings, 'ambiguousBelow' | 'ambiguousMargin'>): boolean {
  if (s.corpus === 'strokes' && /^ambiguous:/i.test(s.rec.label.note ?? '')) return true
  if (s.corpus === 'strokes-indep' && s.split === 'train' && s.hypothesis.confidence < 0.6) return true
  return shouldRescore(s.hypothesis, { ...rs, adapter: 'hosted' })
}

export type CassetteSource = 'recorded' | 'synthetic'

export function cassetteDir(root: string, source: CassetteSource, adapter: AdapterId): string {
  return resolve(root, 'fixtures', 'cassettes', source, adapter)
}

export function loadCassettes(dir: string): Cassette[] {
  if (!existsSync(dir)) return []
  const out: Cassette[] = []
  for (const n of readdirSync(dir).sort()) {
    if (!n.endsWith('.json')) continue
    try {
      const c = JSON.parse(readFileSync(join(dir, n), 'utf8')) as unknown
      if (isCassette(c)) out.push(c)
    } catch {
      // unreadable cassette: ignored (reported as a miss)
    }
  }
  return out
}

export function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true })
}

/** Minimal .env.local reader (KEY=VALUE lines); process.env wins. */
export function readEnvLocal(root: string): Record<string, string> {
  const p = resolve(root, '.env.local')
  const out: Record<string, string> = {}
  if (existsSync(p))
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
    }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v
  return out
}
