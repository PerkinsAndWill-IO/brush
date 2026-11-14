/**
 * Budget gates for `pnpm verify` (runs after check, e2e and eval).
 * Reads reports/perf.json and reports/eval.json; fails if any budget that has
 * data is missed. Budgets without data are "pending (Mx)" and do not fail.
 * Writes reports/budgets.json with the table.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUDGETS, passes } from './budgets'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reports = resolve(root, 'reports')

function readMetrics(file: string): Record<string, number> {
  const p = resolve(reports, file)
  if (!existsSync(p)) return {}
  const json = JSON.parse(readFileSync(p, 'utf8')) as { metrics?: Record<string, unknown> }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(json.metrics ?? {})) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  return out
}

// perf-context.json (written by the context unit tests) supplies snapDecisionMs; perf.json (in-app, e2e) wins on overlap.
const data = { perf: { ...readMetrics('perf-context.json'), ...readMetrics('perf.json') }, eval: readMetrics('eval.json') }

type Row = { id: string; measure: string; budget: string; measured: string; status: 'pass' | 'FAIL' | string }
const rows: Row[] = BUDGETS.map((b) => {
  const v = data[b.source][b.key]
  const op = { lte: '<=', gte: '>=', lt: '<' }[b.cmp]
  const budget = `${op} ${b.budget} ${b.unit}`
  if (v === undefined) return { id: b.id, measure: b.measure, budget, measured: '-', status: `pending (${b.from})` }
  return { id: b.id, measure: b.measure, budget, measured: `${+v.toFixed(3)} ${b.unit}`, status: passes(b, v) ? 'pass' : 'FAIL' }
})

const w = (k: keyof Row) => Math.max(k.length, ...rows.map((r) => r[k].length))
const cols: (keyof Row)[] = ['id', 'budget', 'measured', 'status']
console.log('\nBudget gates')
console.log(cols.map((c) => c.padEnd(w(c))).join('  '))
for (const r of rows) console.log(cols.map((c) => r[c].padEnd(w(c))).join('  '))

mkdirSync(reports, { recursive: true })
writeFileSync(resolve(reports, 'budgets.json'), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2))

const failed = rows.filter((r) => r.status === 'FAIL')
if (failed.length) {
  console.error(`\n${failed.length} budget(s) missed: ${failed.map((r) => r.id).join(', ')}`)
  process.exit(1)
}
console.log(`\nAll budgets with data pass (${rows.filter((r) => r.status === 'pass').length} measured, ${rows.filter((r) => r.status.startsWith('pending')).length} pending).`)
