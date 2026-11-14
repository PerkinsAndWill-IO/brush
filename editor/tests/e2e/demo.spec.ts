/**
 * Demo screenshots on the real KRO project bundle (3 A0 sheets: plan, elevation,
 * axonometric). No ground truth here: assertions stay on the synthetic office
 * fixtures; this spec only checks the flow runs and saves reports/screens/demo-*.png.
 */
import { expect, test, type Page } from '@playwright/test'
import type { StrokeRecording } from '../../src/core/types'
import { screenPath } from './helpers'
import { openWith, settle } from './m1-helpers'

const KRO = 'kro-project-3-sheets.pdf'
test.setTimeout(300_000)

const stroke = (pts: [number, number][], step = 9): StrokeRecording => {
  // resample the polyline every ~6 pt so it replays like a pen
  const out: StrokeRecording['points'] = []
  let t = 0
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]
    const [bx, by] = pts[i]
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 6))
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      out.push({ x: ax + ((bx - ax) * k) / n, y: ay + ((by - ay) * k) / n, t, p: 0.45 + 0.1 * Math.sin(t / 60) })
      t += step
    }
  }
  return { pdf: KRO, sheet: 0, label: { kind: 'markup' }, points: out }
}

async function allRendered(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="sheet"]')].every((e) => e.getAttribute('data-rendered') === 'true'), undefined, {
    timeout: 240_000,
    polling: 500,
  })
  // full-resolution renders replace the quick previews later (hardening lane); wait for them when we can
  await page
    .waitForFunction(() => !document.querySelector('[data-testid="sheet"] canvas[data-preview]'), undefined, { timeout: 180_000, polling: 1000 })
    .catch(() => console.log('demo: some sheets still show their preview raster'))
}

test('demo: KRO bundle — board overview, plan with sketches, live reading on the plan', async ({ page }) => {
  await openWith(page, KRO, { live: false })
  expect(await page.evaluate(() => window.__brush!.sheets().length)).toBe(3)
  await allRendered(page)
  await settle(page)
  await page.screenshot({ path: screenPath('demo-overview') })

  // plan zoomed in, a few plain sketches (Live off)
  const plan = (await page.evaluate(() => window.__brush!.sheets()))[0]
  const { w, h } = plan.sizePt
  const cx = w * 0.42
  const cy = h * 0.45
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 4))
  await page.evaluate(
    ([x, y]) => {
      const r = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
      window.__brushDev!.setCamera({ x: r.width / 2 / 0.9 - x, y: r.height / 2 / 0.9 - y, z: 0.9 })
    },
    [cx, cy] as const,
  )
  await settle(page)
  await allRendered(page)
  const sketches = [
    stroke([[cx - 300, cy - 180], [cx + 150, cy - 180]]),
    stroke([[cx + 150, cy - 180], [cx + 150, cy + 120], [cx - 120, cy + 120]]),
    stroke(Array.from({ length: 25 }, (_, i) => [cx - 220 + 40 * Math.cos((i / 24) * 2 * Math.PI), cy + 10 + 40 * Math.sin((i / 24) * 2 * Math.PI)] as [number, number])),
  ]
  for (const s of sketches) await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), s)
  await page.screenshot({ path: screenPath('demo-plan-sketches') })

  // Live on: ghost + chip mid-stroke, then the committed element
  await page.evaluate(() => window.__brush!.setSetting('live', true))
  await page.evaluate(() => window.__brush!.contextFor(window.__brush!.sheets()[0].id))
  const wall = stroke([[cx - 300, cy + 260], [cx + 260, cy + 260]], 8)
  await page.evaluate((r) => {
    ;(window as unknown as { __p: Promise<void> }).__p = window.__brush!.replayStroke(r, { realtime: true })
  }, wall)
  await page.waitForTimeout(wall.points[wall.points.length - 1].t * 0.7)
  await page.screenshot({ path: screenPath('demo-plan-live') })
  await page.evaluate(() => (window as unknown as { __p: Promise<void> }).__p)
  await page.waitForFunction(() => ['committed', 'markup', 'offer'].includes(window.__brushDev!.live().phase), undefined, { timeout: 5000 })
  await page.screenshot({ path: screenPath('demo-plan-committed') })
})
