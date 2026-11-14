import { rmSync } from 'node:fs'
import { PERF_JSON } from './helpers'

/** perf.json must only hold numbers from this run, so budgets are never judged on stale data. */
export default function globalSetup() {
  rmSync(PERF_JSON, { force: true })
}
