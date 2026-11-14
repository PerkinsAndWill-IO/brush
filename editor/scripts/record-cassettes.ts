/**
 * Record second-pass cassettes (M4-01). One JSON file per request in
 * fixtures/cassettes/<recorded|synthetic>/<adapter>/<requestHash>.json.
 *
 * Real recording (needs a key or a running server; never run in CI):
 *   pnpm exec tsx scripts/record-cassettes.ts --adapter=hosted   # VERCEL_AI_GATEWAY_API_KEY in env or .env.local
 *   pnpm exec tsx scripts/record-cassettes.ts --adapter=local    # BRUSH_LOCAL_URL (default http://127.0.0.1:8080/v1/chat/completions), BRUSH_LOCAL_MODEL
 *   pnpm exec tsx scripts/record-cassettes.ts --adapter=jev      # BRUSH_JEV_URL (required), BRUSH_JEV_KEY optional
 *   Options: --limit=N  --dry-run (list the selection, call nothing)  --model=<id> (hosted/local model override)
 *
 * Synthetic set (no network; deterministic oracle-with-noise that KNOWS THE LABEL —
 * proves plumbing, not model quality):
 *   pnpm exec tsx scripts/record-cassettes.ts --synthetic [--adapter=hosted]
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADAPTERS,
  CASSETTE_SCHEMA,
  DEFAULT_RESCORE_SETTINGS,
  SYNTHETIC_NOTE,
  canonicalJson,
  codecFor,
  oracleProbs,
  requestHash,
  syntheticLatency,
  syntheticResponse,
  type AdapterId,
  type Cassette,
  type RescoreCodec,
} from '../src/core/rescore/index'
import { hostedRescorer, jevRescorer, localRescorer } from '../src/app/rescore/adapters'
import type { HttpRescorer } from '../src/app/rescore/http'
import { cassetteDir, ensureDir, loadRescoreCorpus, readEnvLocal, recordSelection, type CorpusStroke } from './rescore-corpus'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const SYNTHETIC = args.includes('--synthetic')
const DRY = args.includes('--dry-run')
const LIMIT = arg('limit') ? Number(arg('limit')) : Infinity
const adapterArg = arg('adapter') as AdapterId | undefined
if (adapterArg && !ADAPTERS.includes(adapterArg)) {
  console.error(`--adapter must be one of ${ADAPTERS.join(', ')}`)
  process.exit(2)
}

function summary(s: CorpusStroke): Record<string, unknown> {
  const out: Record<string, unknown> = {
    source: s.file,
    corpus: s.corpus,
    split: s.split,
    label: s.label,
    firstPass: s.packet.candidates.map((c) => [c.kind, Math.round(c.confidence * 1000) / 1000]),
  }
  if (s.rec.label.note) out.note = s.rec.label.note
  if (s.packet.roomLabel) out.room = s.packet.roomLabel
  return out
}

function writeCassette(dir: string, c: Cassette): boolean {
  const p = join(dir, `${c.requestHash}.json`)
  if (existsSync(p)) {
    // keep the file (and its recordedAt) when nothing else changed: regenerating is idempotent
    try {
      const old = JSON.parse(readFileSync(p, 'utf8')) as Cassette
      if (canonicalJson({ ...old, recordedAt: '' }) === canonicalJson({ ...c, recordedAt: '' })) return false
    } catch {
      // overwrite unreadable file
    }
  }
  writeFileSync(p, JSON.stringify(c, null, 1) + '\n')
  return true
}

function generateSynthetic(strokes: CorpusStroke[], adapters: readonly AdapterId[]) {
  for (const adapter of adapters) {
    const codec = codecFor(adapter)
    const dir = cassetteDir(root, 'synthetic', adapter)
    ensureDir(dir)
    const keep = new Set<string>()
    let written = 0
    for (const s of strokes) {
      const body = codec.buildRequest(s.packet)
      const hash = requestHash(adapter, codec.model, body)
      if (keep.has(hash)) continue
      keep.add(hash)
      const p = oracleProbs(s.packet, s.label, hash)
      const c: Cassette = {
        schema: CASSETTE_SCHEMA,
        adapter,
        model: codec.model,
        requestHash: hash,
        requestSummary: summary(s),
        request: body,
        response: syntheticResponse(adapter, codec.model, p),
        latencyMs: syntheticLatency(adapter, hash),
        recordedAt: new Date().toISOString(),
        synthetic: true,
        note: SYNTHETIC_NOTE,
      }
      if (writeCassette(dir, c)) written++
    }
    // drop stale synthetic cassettes (requests the current first pass no longer makes)
    let removed = 0
    for (const n of readdirSync(dir))
      if (n.endsWith('.json') && !keep.has(n.slice(0, -5))) {
        rmSync(join(dir, n))
        removed++
      }
    console.log(`synthetic/${adapter}: ${keep.size} cassettes (${written} written, ${removed} stale removed) -> ${relative(root, dir)}`)
  }
  console.log(`\n${SYNTHETIC_NOTE}`)
}

function realAdapter(adapter: AdapterId, env: Record<string, string>): { rescorer: HttpRescorer; codec: RescoreCodec } | string {
  const base = { ...DEFAULT_RESCORE_SETTINGS, timeoutMs: 30_000 }
  switch (adapter) {
    case 'hosted': {
      const apiKey = env.VERCEL_AI_GATEWAY_API_KEY || env.AI_GATEWAY_API_KEY
      if (!apiKey)
        return 'No AI Gateway key. Put VERCEL_AI_GATEWAY_API_KEY=... in editor/.env.local (never committed) or the environment, then re-run.\nTo exercise the pipeline without a key: pnpm exec tsx scripts/record-cassettes.ts --synthetic'
      const rescorer = hostedRescorer({ ...base, hostedModel: arg('model') ?? base.hostedModel, hostedBaseUrl: env.BRUSH_HOSTED_BASE_URL || base.hostedBaseUrl }, { apiKey })
      return { rescorer, codec: rescorer.opts.codec }
    }
    case 'local': {
      const rescorer = localRescorer(
        { ...base, localUrl: env.BRUSH_LOCAL_URL || base.localUrl, localModel: arg('model') ?? (env.BRUSH_LOCAL_MODEL || base.localModel), localGrammar: env.BRUSH_LOCAL_GRAMMAR !== '0' },
        { apiKey: env.BRUSH_LOCAL_KEY },
      )
      return { rescorer, codec: rescorer.opts.codec }
    }
    case 'jev': {
      if (!env.BRUSH_JEV_URL) return 'No Jev endpoint. Set BRUSH_JEV_URL (and BRUSH_JEV_KEY if needed) in editor/.env.local. The Jev contract is ASSUMED (see src/core/rescore/codecs.ts).'
      const rescorer = jevRescorer({ ...base, jevUrl: env.BRUSH_JEV_URL }, { apiKey: env.BRUSH_JEV_KEY })
      return { rescorer, codec: rescorer.opts.codec }
    }
  }
}

async function recordReal(strokes: CorpusStroke[], adapter: AdapterId) {
  const env = readEnvLocal(root)
  const made = realAdapter(adapter, env)
  if (typeof made === 'string') {
    console.error(made)
    process.exit(2)
  }
  const { rescorer, codec } = made
  const dir = cassetteDir(root, 'recorded', adapter)
  ensureDir(dir)
  let ok = 0
  let failed = 0
  const seen = new Set<string>()
  for (const s of strokes.slice(0, LIMIT)) {
    const body = codec.buildRequest(s.packet)
    const hash = requestHash(adapter, codec.model, body)
    if (seen.has(hash)) continue
    seen.add(hash)
    try {
      const { raw, latencyMs } = await rescorer.call(s.packet)
      codec.parseResponse(raw) // fail loudly on an unreadable reply instead of storing it
      writeCassette(dir, {
        schema: CASSETTE_SCHEMA,
        adapter,
        model: codec.model,
        requestHash: hash,
        requestSummary: summary(s),
        request: body,
        response: raw,
        latencyMs: Math.round(latencyMs),
        recordedAt: new Date().toISOString(),
        synthetic: false,
      })
      ok++
      console.log(`  ${s.file.padEnd(48)} ${Math.round(latencyMs)} ms`)
    } catch (e) {
      failed++
      console.error(`  ${s.file.padEnd(48)} FAILED: ${e instanceof Error ? e.message : String(e)}`)
      if (ok === 0 && failed >= 3) {
        console.error(`\nFirst ${failed} calls failed; is the ${adapter} endpoint up (${rescorer.opts.url}) and the key valid? Stopping.`)
        process.exit(1)
      }
    }
  }
  console.log(`\nrecorded/${adapter}: ${ok} cassettes written, ${failed} failed -> ${relative(root, dir)}`)
  console.log('Next: pnpm exec tsx tests/eval/run-rescore.ts --source=recorded --adapter=' + adapter)
}

async function main() {
  const all = loadRescoreCorpus(root)
  const selected = all.filter((s) => recordSelection(s, DEFAULT_RESCORE_SETTINGS))
  console.log(`Corpus: ${all.length} strokes; selected for the second pass: ${selected.length} (ambiguous notes, low-confidence indep train, and policy-triggered)`)
  if (DRY) {
    for (const s of selected) console.log(`  ${s.file.padEnd(48)} ${s.split.padEnd(8)} first pass ${s.hypothesis.kind} ${s.hypothesis.confidence.toFixed(2)}`)
    return
  }
  if (SYNTHETIC) return generateSynthetic(selected, adapterArg ? [adapterArg] : ADAPTERS)
  await recordReal(selected, adapterArg ?? 'hosted')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
