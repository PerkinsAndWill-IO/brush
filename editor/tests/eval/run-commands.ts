/**
 * M5 exit check: the same stroke corpus yields the expected command list from a package and from a plain PDF.
 *
 *   pnpm exec tsx tests/eval/run-commands.ts [--write-golden]
 *
 * For every held-out recording of fixtures/strokes and fixtures/strokes-indep: StrokeSession to commit
 * (feed points, end, tick past the pause), twice: plain-PDF context (fixtures/contexts/*.json, inferred) and
 * package context (fixtures/packages/*.drawing via contextFromPackage). Commands come from commandFromDecision.
 * Expected values come from the labels (expectedOp, note "target:<id>", the wall id named in a door note), never
 * from the predictor. Writes reports/commands.json; --write-golden rewrites fixtures/expected-commands/*.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandFromDecision } from '../../src/core/commands'
import { contextFromPackage } from '../../src/core/context'
import { StrokeSession } from '../../src/core/predict'
import { settings as entrySettings } from '../../src/core/predict/eval-entry'
import { parseManifest } from '../../src/app/source/package-file'
import {
  DECISION_KINDS,
  DEFAULT_BRUSH_SETTINGS,
  type BrushSettings,
  type Command,
  type CommandOp,
  type SheetContext,
  type Stroke,
  type StrokeRecording,
} from '../../src/core/types/index'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WRITE_GOLDEN = process.argv.includes('--write-golden')
const CORPORA = ['strokes', 'strokes-indep']
const settings: BrushSettings = { ...DEFAULT_BRUSH_SETTINGS, ...entrySettings }

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n)
      if (statSync(p).isDirectory()) return walk(p)
      return n.endsWith('.json') && n !== 'index.json' && n !== 'manifest.json' ? [p] : []
    })
}

interface Rec {
  file: string
  corpus: string
  rec: StrokeRecording
}
const recs: Rec[] = []
for (const c of CORPORA) {
  for (const f of walk(resolve(root, 'fixtures', c))) {
    const j = JSON.parse(readFileSync(f, 'utf8')) as StrokeRecording | StrokeRecording[]
    for (const r of Array.isArray(j) ? j : [j]) {
      if (r && Array.isArray(r.points) && r.label && DECISION_KINDS.includes(r.label.kind)) recs.push({ file: relative(root, f).replace(/\\/g, '/'), corpus: c, rec: r })
    }
  }
}

// ── packages: manifest + idmap per PDF (office-6-sheets, office-1-sheet); none for the scanned PDF ──
interface Pkg {
  manifest: ReturnType<typeof parseManifest>
  idmap: Record<string, string>
}
const packages = new Map<string, Pkg>()
for (const f of existsSync(resolve(root, 'fixtures/packages')) ? readdirSync(resolve(root, 'fixtures/packages')) : []) {
  if (!f.endsWith('.drawing')) continue
  const name = f.replace(/\.drawing$/, '')
  const manifest = parseManifest(JSON.parse(readFileSync(resolve(root, 'fixtures/packages', f), 'utf8')))
  const idmapPath = resolve(root, 'fixtures/packages', `${name}.idmap.json`)
  packages.set(`${name}.pdf`, { manifest, idmap: existsSync(idmapPath) ? (JSON.parse(readFileSync(idmapPath, 'utf8')) as Record<string, string>) : {} })
}

function plainContext(rec: StrokeRecording): SheetContext {
  const p = resolve(root, 'fixtures/contexts', `${rec.pdf}.${rec.sheet}.json`)
  if (!existsSync(p)) return { sheetId: `sheet-${rec.sheet}`, origin: 'inferred', items: [], shapeOnly: true }
  return JSON.parse(readFileSync(p, 'utf8')) as SheetContext
}

function packageContext(rec: StrokeRecording): SheetContext | null {
  const pkg = packages.get(rec.pdf)
  if (!pkg) return null
  return contextFromPackage(pkg.manifest, pkg.manifest.sheets[rec.sheet]?.id)
}

function firstPass(rec: StrokeRecording, ctx: SheetContext, strokeId: string): Command | null {
  const stroke: Stroke = { id: strokeId, sheetId: ctx.sheetId, points: [], tool: rec.tool ?? 'brush', size: settings.size }
  const s = new StrokeSession(stroke, ctx, settings)
  for (const p of rec.points) s.addPoint(p)
  s.end()
  const lastT = rec.points.length ? rec.points[rec.points.length - 1].t : 0
  const d = s.tick(lastT + settings.commitPauseMs + 1) ?? s.commit(0)
  return commandFromDecision(d, 'cmd-0001', ctx)
}

// ── expected values from labels ──
interface Expected {
  op: CommandOp | null
  /** Package only: host id of the wall the door sits in / ids that a delete may target (any one counts). */
  hostWallRef?: string
  targets?: string[]
}
const NOTE_ID = /\b([wfdg]\d+-\d+)\b/g
function expectedFor(rec: StrokeRecording): { op: CommandOp | null; truthWall?: string; truthTarget?: string } {
  const note = rec.label.note ?? ''
  const op = rec.expectedOp !== undefined ? rec.expectedOp : null
  const out: { op: CommandOp | null; truthWall?: string; truthTarget?: string } = { op }
  if (rec.label.kind === 'delete') out.truthTarget = /target:\s*([wfdg]\d+-\d+)/.exec(note)?.[1]
  if (rec.label.kind === 'door') {
    const ids = [...new Set([...note.matchAll(NOTE_ID)].map((m) => m[1]).filter((i) => i.startsWith('w')))]
    if (ids.length === 1) out.truthWall = ids[0]
  }
  return out
}
function packageExpected(rec: StrokeRecording): Expected | null {
  const pkg = packages.get(rec.pdf)
  if (!pkg) return null
  const e = expectedFor(rec)
  const out: Expected = { op: e.op }
  if (e.truthWall) {
    const h = pkg.idmap[`${rec.sheet}:${e.truthWall}`]
    if (h) out.hostWallRef = h
  }
  if (e.truthTarget) {
    const h = pkg.idmap[`${rec.sheet}:${e.truthTarget}`]
    if (h) out.targets = [h]
  }
  return out
}

interface Row {
  file: string
  corpus: string
  kind: string
  split: string
  expectedOp: CommandOp | null
  plainOp: CommandOp | null
  packageOp: CommandOp | null | 'n/a'
  plainOk: boolean
  packageOk: boolean | null
  agree: boolean | null
  hostRefExpected: boolean
  hostRefOk: boolean | null
  plainHostRefOk: boolean | null
  detail?: string
}

const rows: Row[] = []
for (const { file, corpus, rec } of recs) {
  const exp = expectedFor(rec)
  const pctx = plainContext(rec)
  const kctx = packageContext(rec)
  const plainCmd = firstPass(rec, pctx, `plain:${file}`)
  const pkgCmd = kctx ? firstPass(rec, kctx, `pkg:${file}`) : null
  const pe = packageExpected(rec)
  let hostRefOk: boolean | null = null
  let hostRefExpected = false
  if (pe && pkgCmd) {
    if (pe.hostWallRef !== undefined) {
      hostRefExpected = true
      hostRefOk = pkgCmd.op === 'place_door' && pkgCmd.hostWallRef === pe.hostWallRef
    } else if (pe.targets) {
      hostRefExpected = true
      hostRefOk = pkgCmd.op === 'delete' && pkgCmd.targets.some((t) => pe.targets!.includes(t))
    }
  } else if (pe && (pe.hostWallRef !== undefined || pe.targets)) {
    hostRefExpected = true
    hostRefOk = false
  }
  // plain run: the only host-ish check available is "a door names some wall, a delete names some target".
  let plainHostRefOk: boolean | null = null
  if (exp.truthWall !== undefined) plainHostRefOk = plainCmd?.op === 'place_door' && !!plainCmd.hostWallRef
  else if (exp.truthTarget !== undefined) plainHostRefOk = plainCmd?.op === 'delete' && plainCmd.targets.length > 0
  const pOp = plainCmd?.op ?? null
  const kOp = kctx ? (pkgCmd?.op ?? null) : 'n/a'
  rows.push({
    file,
    corpus,
    kind: rec.label.kind,
    split: rec.split ?? 'train',
    expectedOp: exp.op,
    plainOp: pOp,
    packageOp: kOp,
    plainOk: pOp === exp.op,
    packageOk: kctx ? kOp === exp.op : null,
    agree: kctx ? kOp === pOp : null,
    hostRefExpected,
    hostRefOk,
    plainHostRefOk,
  })
}

const held = rows.filter((r) => r.split === 'heldout')
const frac = (xs: boolean[]): { n: number; ok: number; rate: number | null } => ({ n: xs.length, ok: xs.filter(Boolean).length, rate: xs.length ? xs.filter(Boolean).length / xs.length : null })
const pct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(1)}%`)

function summarize(rs: Row[]) {
  const withPkg = rs.filter((r) => r.packageOk !== null)
  const hr = rs.filter((r) => r.hostRefExpected)
  const phr = rs.filter((r) => r.plainHostRefOk !== null)
  return {
    n: rs.length,
    plainOpAgreement: frac(rs.map((r) => r.plainOk)),
    packageOpAgreement: frac(withPkg.map((r) => r.packageOk === true)),
    plainOpAgreementOnPackageSubset: frac(withPkg.map((r) => r.plainOk)),
    crossSourceAgreement: frac(withPkg.map((r) => r.agree === true)),
    packageHostRefCorrect: frac(hr.map((r) => r.hostRefOk === true)),
    plainHostRefPresent: frac(phr.map((r) => r.plainHostRefOk === true)),
  }
}

const perKind = Object.fromEntries(DECISION_KINDS.map((k) => [k, summarize(held.filter((r) => r.kind === k))]))
const perCorpus = Object.fromEntries(CORPORA.map((c) => [c, summarize(held.filter((r) => r.corpus === c))]))
const overall = summarize(held)
const differ = held.filter((r) => r.agree === false)
const pkgWrong = held.filter((r) => r.packageOk === false)
const plainWrong = held.filter((r) => !r.plainOk)
const brief = (r: Row) => ({ file: r.file, kind: r.kind, expected: r.expectedOp, plain: r.plainOp, package: r.packageOp })

// ── golden expected commands from labels ──
function golden(corpus: string) {
  return {
    note: 'Generated by tests/eval/run-commands.ts --write-golden from recording labels (never from the predictor).',
    corpus,
    recordings: recs
      .filter((r) => r.corpus === corpus)
      .map(({ file, rec }) => {
        const e = expectedFor(rec)
        const pe = packageExpected(rec)
        const out: Record<string, unknown> = { file: basename(file), split: rec.split ?? 'train', pdf: rec.pdf, sheet: rec.sheet, expectedOp: e.op }
        if (pe?.hostWallRef !== undefined) out.hostWallRef = pe.hostWallRef
        if (pe?.targets) out.targets = pe.targets
        if (e.truthTarget) out.truthTarget = e.truthTarget
        if (e.truthWall) out.truthWall = e.truthWall
        return out
      }),
  }
}
const goldenDir = resolve(root, 'fixtures', 'expected-commands')
let goldenStatus = 'unchanged'
for (const c of CORPORA) {
  const text = JSON.stringify(golden(c), null, 1) + '\n'
  const p = join(goldenDir, `${c}.json`)
  if (WRITE_GOLDEN) {
    mkdirSync(goldenDir, { recursive: true })
    writeFileSync(p, text)
    goldenStatus = 'written'
  } else if (!existsSync(p) || readFileSync(p, 'utf8') !== text) goldenStatus = 'DIFFERS (run with --write-golden after checking the labels)'
}

const report = {
  generatedAt: new Date().toISOString(),
  basis: 'heldout',
  packages: [...packages.keys()],
  noPackageFor: [...new Set(held.filter((r) => r.packageOk === null).map((r) => recs.find((x) => x.file === r.file)!.rec.pdf))],
  overall,
  perCorpus,
  perKind,
  differences: differ.map(brief),
  packageWrong: pkgWrong.map(brief),
  plainWrong: plainWrong.map(brief),
  hostRefMisses: held.filter((r) => r.hostRefExpected && !r.hostRefOk).map(brief),
  golden: goldenStatus,
  all: { ...summarize(rows) },
}
mkdirSync(resolve(root, 'reports'), { recursive: true })
writeFileSync(resolve(root, 'reports', 'commands.json'), JSON.stringify(report, null, 2))

const line = (name: string, s: ReturnType<typeof summarize>) =>
  `${name.padEnd(14)} n=${String(s.n).padStart(3)}  plain ${pct(s.plainOpAgreement.rate).padStart(6)}  package ${pct(s.packageOpAgreement.rate).padStart(6)} (plain on same ${pct(s.plainOpAgreementOnPackageSubset.rate)})  cross ${pct(s.crossSourceAgreement.rate).padStart(6)}  hostRef ${s.packageHostRefCorrect.ok}/${s.packageHostRefCorrect.n}`
console.log(`M5 command agreement, held-out (${held.length} recordings), golden ${goldenStatus}`)
console.log(line('overall', overall))
for (const c of CORPORA) console.log(line(c, perCorpus[c]))
for (const k of DECISION_KINDS) console.log(line(k, perKind[k]))
console.log(`\nplain-vs-package differences: ${differ.length}`)
for (const r of differ) console.log(`  ${r.file}  expected ${r.expectedOp}  plain ${r.plainOp}  package ${r.packageOp}`)
console.log('\nwrote reports/commands.json')
