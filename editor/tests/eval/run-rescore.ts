/**
 * `pnpm exec tsx tests/eval/run-rescore.ts` — M4 eval from cassettes (no network, no keys).
 *
 * First pass vs first pass + second pass on (a) the ambiguous subset (label.note "ambiguous...")
 * and (b) all held-out strokes, plus everything. The second pass is only called when the
 * ambiguity policy says so, at pen up; its answer arrives `latencyMs` (from the cassette) later.
 * Commit happens `commitPauseMs` after pen up and never waits:
 *   - answer before commit -> applied to the live hypothesis (counts for `committed` accuracy)
 *   - answer after commit  -> rule 6: suggestion chip only (counts for `answer` accuracy, the
 *                             upper bound if the user takes every chip), never re-decides
 * A second, real-time pass drives RescoreRunner + CassetteRescorer with real timers and asserts
 * that the first pass and commit never await the rescorer (M4-03), including with a slow cassette.
 *
 * Flags: --adapter=hosted|local|jev (default hosted)
 *        --source=recorded|synthetic (default: recorded if that adapter has any, else synthetic)
 *        --weight=0.5
 *
 * SYNTHETIC cassettes come from an oracle that knows the label: their accuracy numbers prove the
 * plumbing works, NOT that any model helps. The report says so in `synthetic` and `warning`.
 *
 * Writes reports/rescore.json { metrics: { secondPassP95Ms, ... }, subsets, strokes }.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DEFAULT_BRUSH_SETTINGS, type DecisionKind } from '../../src/core/types/index'
import {
  ADAPTERS,
  CassetteRescorer,
  DEFAULT_RESCORE_SETTINGS,
  RescoreRunner,
  SYNTHETIC_NOTE,
  codecFor,
  finishRescore,
  quantile,
  resolveAnswer,
  shouldRescore,
  type AdapterId,
  type RescoreResult,
  type RescoreSettings,
} from '../../src/core/rescore/index'
import { cassetteDir, loadCassettes, loadRescoreCorpus, type CassetteSource, type CorpusStroke } from '../../scripts/rescore-corpus'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const ADAPTER = (arg('adapter') ?? 'hosted') as AdapterId
if (!ADAPTERS.includes(ADAPTER)) {
  console.error(`--adapter must be one of ${ADAPTERS.join(', ')}`)
  process.exit(2)
}
const OUT = resolve(root, 'reports', 'rescore.json')

interface StrokeOutcome {
  file: string
  corpus: string
  split: 'train' | 'heldout'
  ambiguous: boolean
  label: DecisionKind
  firstPass: DecisionKind
  firstConfidence: number
  called: boolean
  miss: boolean
  latencyMs?: number
  /** Second-pass (fused) top kind, when answered. */
  answer?: DecisionKind
  answerConfidence?: number
  /** What the engine did with the answer (rule 6). */
  action?: 'apply' | 'suggest' | 'drop'
  committed: DecisionKind
}

const acc = (rs: StrokeOutcome[], pick: (r: StrokeOutcome) => DecisionKind) => (rs.length ? rs.filter((r) => pick(r) === r.label).length / rs.length : NaN)

function subset(rs: StrokeOutcome[]) {
  const called = rs.filter((r) => r.called && !r.miss)
  return {
    n: rs.length,
    calls: called.length,
    misses: rs.filter((r) => r.miss).length,
    firstPassTop1: acc(rs, (r) => r.firstPass),
    committedTop1: acc(rs, (r) => r.committed),
    answerTop1: acc(rs, (r) => r.answer ?? r.firstPass),
    committedDelta: acc(rs, (r) => r.committed) - acc(rs, (r) => r.firstPass),
    answerDelta: acc(rs, (r) => r.answer ?? r.firstPass) - acc(rs, (r) => r.firstPass),
    changedCommitted: rs.filter((r) => r.committed !== r.firstPass).length,
    changedAnswer: called.filter((r) => r.answer !== r.firstPass).length,
    applied: rs.filter((r) => r.action === 'apply').length,
    suggestions: rs.filter((r) => r.action === 'suggest').length,
    suggestionsCorrect: rs.filter((r) => r.action === 'suggest' && r.answer === r.label).length,
    late: called.filter((r) => (r.latencyMs ?? 0) > DEFAULT_BRUSH_SETTINGS.commitPauseMs).length,
  }
}

/** Virtual-time replay: decisions and accuracy (deterministic). */
function evaluate(strokes: CorpusStroke[], rescorer: CassetteRescorer, rs: RescoreSettings): StrokeOutcome[] {
  const codec = codecFor(ADAPTER)
  return strokes.map((s) => {
    const h = s.hypothesis
    const o: StrokeOutcome = {
      file: s.file,
      corpus: s.corpus,
      split: s.split,
      ambiguous: s.ambiguous,
      label: s.label,
      firstPass: h.kind,
      firstConfidence: Math.round(h.confidence * 1000) / 1000,
      called: shouldRescore(h, rs),
      miss: false,
      committed: h.kind,
    }
    if (!o.called) return o
    const c = rescorer.lookup(s.packet)
    if (!c) {
      o.miss = true
      return o
    }
    const hyps = finishRescore(codec, c.response, s.packet, [h], rs.weight)
    o.latencyMs = c.latencyMs
    o.answer = hyps[0].kind
    o.answerConfidence = hyps[0].confidence
    // Sent at pen up; commit at pen up + commitPauseMs; answer at pen up + latency.
    const beforeCommit = c.latencyMs < DEFAULT_BRUSH_SETTINGS.commitPauseMs
    const strokeId = s.stroke.id
    const a = resolveAnswer(
      { strokeId, run: h.run, hypotheses: hyps },
      beforeCommit ? { strokeId, run: h.run } : { strokeId, run: h.run, committed: { strokeId, kind: h.kind } },
      rs,
    )
    o.action = a.action
    if (a.action === 'apply') o.committed = a.hypothesis.kind
    return o
  })
}

/**
 * Real-time check of M4-03 with real timers: for every policy-triggered stroke, pen up ->
 * runner.consider() -> commit, and the commit must happen before any answer arrives and
 * consider() must return in well under a frame. `latency` overrides the cassette latency
 * (a slow cassette) to show timeouts do not block either.
 */
async function noWaitCheck(strokes: CorpusStroke[], cassettes: ReturnType<typeof loadCassettes>, rs: RescoreSettings, latency?: number) {
  const rescorer = new CassetteRescorer({ codec: codecFor(ADAPTER), cassettes, weight: rs.weight, latencyMs: latency })
  const order: string[] = []
  const results: RescoreResult[] = []
  const runner = new RescoreRunner({ rescorer, settings: rs, now: () => performance.now(), onResult: (r) => (order.push(`answer:${r.strokeId}`), results.push(r)) })
  const considerMs: number[] = []
  let started = 0
  const t0 = performance.now()
  for (const s of strokes) {
    const a = performance.now()
    const did = runner.consider({ strokeId: s.stroke.id, run: s.hypothesis.run, packet: s.packet, candidates: [s.hypothesis] })
    considerMs.push(performance.now() - a)
    // commit right away (the commit pause is a timer on the engine side; it does not depend on the answer)
    order.push(`commit:${s.stroke.id}`)
    if (did) started++
  }
  const loopMs = performance.now() - t0
  await runner.idle()
  const violations = strokes.filter((s) => {
    const c = order.indexOf(`commit:${s.stroke.id}`)
    const r = order.indexOf(`answer:${s.stroke.id}`)
    return r !== -1 && r < c
  }).length
  return {
    started,
    considerMaxMs: Math.max(0, ...considerMs),
    considerP95Ms: quantile(considerMs, 0.95),
    loopMs,
    answeredBeforeCommit: violations,
    counts: { ...runner.counts },
    answerLatencyP95Ms: quantile(runner.secondPassMs, 0.95),
  }
}

const pctS = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '-')
const dS = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pt` : '-')

async function main() {
  const rs: RescoreSettings = { ...DEFAULT_RESCORE_SETTINGS, adapter: ADAPTER, weight: arg('weight') ? Number(arg('weight')) : DEFAULT_RESCORE_SETTINGS.weight }
  const recorded = loadCassettes(cassetteDir(root, 'recorded', ADAPTER))
  const source: CassetteSource = (arg('source') as CassetteSource | undefined) ?? (recorded.length ? 'recorded' : 'synthetic')
  const cassettes = source === 'recorded' ? recorded : loadCassettes(cassetteDir(root, 'synthetic', ADAPTER))
  const synthetic = cassettes.some((c) => c.synthetic)
  const codec = codecFor(ADAPTER)
  const strokes = loadRescoreCorpus(root)
  const rescorer = new CassetteRescorer({ codec, cassettes, weight: rs.weight })

  console.log(`Second pass eval — adapter ${ADAPTER} (${codec.model}), cassettes: ${source} (${cassettes.length}), weight ${rs.weight}`)
  if (synthetic) console.log(`\n*** ${SYNTHETIC_NOTE} ***\n`)
  if (!cassettes.length) console.log(`No cassettes in ${relative(root, cassetteDir(root, source, ADAPTER))}. Generate: pnpm exec tsx scripts/record-cassettes.ts --synthetic`)

  const outcomes = evaluate(strokes, rescorer, rs)
  const subsets = {
    ambiguous: subset(outcomes.filter((o) => o.ambiguous)),
    heldout: subset(outcomes.filter((o) => o.split === 'heldout')),
    ambiguousHeldout: subset(outcomes.filter((o) => o.ambiguous && o.split === 'heldout')),
    all: subset(outcomes),
  }
  const latencies = outcomes.filter((o) => o.latencyMs !== undefined).map((o) => o.latencyMs as number)
  const triggered = strokes.filter((s) => shouldRescore(s.hypothesis, rs))
  const noWait = await noWaitCheck(triggered, cassettes, rs)
  const slow = await noWaitCheck(triggered, cassettes, rs, rs.timeoutMs + 500)

  console.log('subset              n  calls miss  first   committed (delta)     answer (delta)        changed c/a  applied  chips(ok)  late')
  for (const [name, s] of Object.entries(subsets))
    console.log(
      `${name.padEnd(17)} ${String(s.n).padStart(4)} ${String(s.calls).padStart(5)} ${String(s.misses).padStart(4)}  ${pctS(s.firstPassTop1).padStart(6)}  ${pctS(s.committedTop1).padStart(6)} (${dS(s.committedDelta).padStart(9)})  ${pctS(s.answerTop1).padStart(6)} (${dS(s.answerDelta).padStart(9)})  ${String(s.changedCommitted).padStart(4)}/${String(s.changedAnswer).padEnd(4)}  ${String(s.applied).padStart(6)}  ${String(s.suggestions).padStart(4)}(${s.suggestionsCorrect})  ${String(s.late).padStart(4)}`,
    )
  console.log(`\nsecond-pass latency (cassette) p50/p95: ${quantile(latencies, 0.5).toFixed(0)} / ${quantile(latencies, 0.95).toFixed(0)} ms over ${latencies.length} calls${synthetic ? '  [SYNTHETIC latencies]' : ''}`)
  console.log(
    `no-wait (real timers): ${noWait.started} calls, consider() max ${noWait.considerMaxMs.toFixed(2)} ms, answers before commit ${noWait.answeredBeforeCommit}; ` +
      `slow cassette (${rs.timeoutMs + 500} ms): ${slow.counts.timeout} timeouts, consider() max ${slow.considerMaxMs.toFixed(2)} ms, answers before commit ${slow.answeredBeforeCommit}`,
  )

  const NO_WAIT_MAX_MS = 16 // one frame; a blocking call would take the full answer latency
  const failures: string[] = []
  for (const [name, r] of [['normal', noWait], ['slow', slow]] as const) {
    if (r.answeredBeforeCommit > 0) failures.push(`${name}: ${r.answeredBeforeCommit} answer(s) arrived before commit (commit waited)`)
    if (r.considerMaxMs > NO_WAIT_MAX_MS) failures.push(`${name}: consider() took ${r.considerMaxMs.toFixed(1)} ms (> ${NO_WAIT_MAX_MS} ms)`)
  }
  if (slow.counts.ok > 0) failures.push(`slow: ${slow.counts.ok} answer(s) past the ${rs.timeoutMs} ms timeout were accepted`)

  const report = {
    generatedAt: new Date().toISOString(),
    synthetic,
    warning: synthetic ? SYNTHETIC_NOTE : undefined,
    adapter: ADAPTER,
    model: codec.model,
    source,
    cassettes: cassettes.length,
    settings: { weight: rs.weight, ambiguousBelow: rs.ambiguousBelow, ambiguousMargin: rs.ambiguousMargin, timeoutMs: rs.timeoutMs, commitPauseMs: DEFAULT_BRUSH_SETTINGS.commitPauseMs },
    // numbers only (verify.ts ignores non-numbers); secondPassP95Ms is the budget key in scripts/budgets.ts
    metrics: {
      secondPassP95Ms: quantile(latencies, 0.95),
      secondPassP50Ms: quantile(latencies, 0.5),
      secondPassCalls: latencies.length,
      secondPassSynthetic: synthetic ? 1 : 0,
      ambiguousFirstPassTop1: subsets.ambiguous.firstPassTop1,
      ambiguousCommittedTop1: subsets.ambiguous.committedTop1,
      ambiguousAnswerTop1: subsets.ambiguous.answerTop1,
      heldoutFirstPassTop1: subsets.heldout.firstPassTop1,
      heldoutCommittedTop1: subsets.heldout.committedTop1,
      heldoutAnswerTop1: subsets.heldout.answerTop1,
      noWaitConsiderMaxMs: noWait.considerMaxMs,
      noWaitAnswersBeforeCommit: noWait.answeredBeforeCommit + slow.answeredBeforeCommit,
    },
    subsets,
    noWait: { normal: noWait, slowCassette: { latencyMs: rs.timeoutMs + 500, ...slow } },
    strokes: outcomes.filter((o) => o.called),
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`\nwrote ${relative(root, OUT)}`)
  if (failures.length) {
    console.error(`\nNO-WAIT CHECK FAILED:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('no-wait check passed: the first pass and commit never awaited the second pass')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
