/**
 * The budget table from docs/spec.md "Test strategy and budgets", in one place.
 * scripts/verify.ts gates on these. AGENTS.md rule 3: never weaken a budget to
 * get to green; propose the change in a task file and wait for a human.
 *
 * `source`/`key` say where the measured number lives:
 *  - 'perf' → reports/perf.json  { metrics: { [key]: number } }  (written by e2e tests)
 *  - 'eval' → reports/eval.json  { metrics: { [key]: number } }  (written by pnpm eval)
 */
export type Comparator = 'lte' | 'gte' | 'lt'

export interface Budget {
  id: string
  measure: string
  budget: number
  unit: string
  /** measured `cmp` budget must hold, e.g. 'lte' = measured <= budget */
  cmp: Comparator
  from: 'M1' | 'M2' | 'M3' | 'M4'
  source: 'perf' | 'eval'
  key: string
}

export const BUDGETS: Budget[] = [
  { id: 'ink-latency', measure: 'Ink latency, pointer event to painted stroke, p95', budget: 16, unit: 'ms', cmp: 'lte', from: 'M1', source: 'perf', key: 'inkLatencyP95Ms' },
  { id: 'pan-zoom-fps', measure: 'Pan and zoom frame rate with 6 sheets and 500 strokes', budget: 60, unit: 'fps', cmp: 'gte', from: 'M1', source: 'perf', key: 'panZoomFps' },
  { id: 'first-sheet', measure: 'First sheet visible after opening the 6-sheet fixture', budget: 2000, unit: 'ms', cmp: 'lte', from: 'M1', source: 'perf', key: 'firstSheetVisibleMs' },
  { id: 'context-build', measure: 'Context built for one sheet, off the main thread', budget: 1000, unit: 'ms', cmp: 'lte', from: 'M2', source: 'perf', key: 'contextBuildMs' },
  { id: 'snap-decision', measure: 'Snap decision per pointer move', budget: 2, unit: 'ms', cmp: 'lte', from: 'M2', source: 'perf', key: 'snapDecisionMs' },
  { id: 'first-hypothesis', measure: 'First hypothesis after pen-down, p95', budget: 50, unit: 'ms', cmp: 'lte', from: 'M3', source: 'perf', key: 'firstHypothesisP95Ms' },
  { id: 'refresh-rate', measure: 'Hypothesis refresh while drawing', budget: 10, unit: '/s', cmp: 'gte', from: 'M3', source: 'perf', key: 'hypothesisRefreshPerSec' },
  { id: 'top1', measure: 'Top-1 accuracy on the held-out corpus', budget: 0.85, unit: 'ratio', cmp: 'gte', from: 'M3', source: 'eval', key: 'top1Accuracy' },
  { id: 'flips', measure: 'Leading guess flips per stroke, mean', budget: 1, unit: 'flips', cmp: 'lt', from: 'M3', source: 'eval', key: 'flipsPerStrokeMean' },
  { id: 'wrong-element', measure: 'Wrong element committed (not markup)', budget: 0.05, unit: 'ratio', cmp: 'lt', from: 'M3', source: 'eval', key: 'wrongElementRate' },
  { id: 'second-pass', measure: 'Second-pass answer, p95, never blocking', budget: 1000, unit: 'ms', cmp: 'lte', from: 'M4', source: 'perf', key: 'secondPassP95Ms' },
]

export function passes(b: Budget, measured: number): boolean {
  switch (b.cmp) {
    case 'lte':
      return measured <= b.budget
    case 'gte':
      return measured >= b.budget
    case 'lt':
      return measured < b.budget
  }
}
