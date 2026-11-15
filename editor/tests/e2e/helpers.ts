import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SCREENS_DIR = resolve(root, 'reports', 'screens')
export const PERF_JSON = resolve(root, 'reports', 'perf.json')

/** Path for a screenshot under reports/screens. Every e2e test should save one. */
export function screenPath(name: string): string {
  mkdirSync(SCREENS_DIR, { recursive: true })
  return resolve(SCREENS_DIR, name.endsWith('.png') ? name : `${name}.png`)
}

/**
 * Merge measured numbers into reports/perf.json (read by scripts/verify.ts).
 * Keys must match `key` in scripts/budgets.ts (source: 'perf').
 */
export function recordPerf(values: Record<string, number>) {
  mkdirSync(dirname(PERF_JSON), { recursive: true })
  const prev = existsSync(PERF_JSON) ? (JSON.parse(readFileSync(PERF_JSON, 'utf8')) as Record<string, unknown>) : {}
  const metrics = { ...((prev.metrics as Record<string, number>) ?? {}), ...values }
  writeFileSync(PERF_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), metrics }, null, 2))
}

/** Open the app and wait for window.__brush. */
export async function openApp(page: Page, query = '') {
  await page.goto(`/${query}`)
  await page.waitForFunction(() => !!window.__brush)
}

export function p95(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]
}

/**
 * Open the side panel (tool settings, reading, session, filters): it is hidden until the ☰ at the top left is
 * clicked. Does nothing when it is already open. Needs a drawing open (the ☰ shows only then).
 */
export async function openSidePanel(page: Page) {
  const toggle = page.getByTestId('panel-toggle')
  await toggle.waitFor()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.getByTestId('side-panel').waitFor()
}
