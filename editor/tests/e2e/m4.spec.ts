/**
 * M4 second pass in the app, driven by a cassette replayer (CassetteRescorer,
 * synthetic reply per packet, real hash/parse/fusion path). Proves: no stroke
 * waits for the model (commit on time even with a slow answer), a late answer
 * after commit only adds a suggestion chip (rule 6), an early one refines the
 * live reading before commit. Screenshot: m4-suggestion.png.
 */
import { expect, test, type Page } from '@playwright/test'
import { screenPath } from './helpers'
import { openWith, readRecording, settle } from './m1-helpers'

const SIX = 'office-6-sheets.pdf'

async function drawWall(page: Page) {
  const rec = readRecording('wall/wall-000.json') // rules read wall ~0.74, commit after 400 ms
  await page.evaluate((i) => window.__brush!.contextFor(`sheet-${i}`), rec.sheet)
  await page.evaluate((i) => window.__brushDev!.focusSheet(i, 1), rec.sheet)
  await settle(page)
  return page.evaluate(async (r) => {
    await window.__brush!.replayStroke(r, { realtime: true })
    return { strokeId: window.__brushDev!.live().strokeId!, upAt: performance.now() }
  }, rec)
}

test('M4: a slow second pass never delays the commit; its late answer is only a suggestion chip (rule 6)', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  // ambiguousBelow 0.8 so a 0.74 wall asks the model; the cassette answers "door" after 1.5 s
  await page.evaluate(() =>
    window.__brushDev!.useCassetteRescorer({ probs: { door: 0.9, wall: 0.05 }, latencyMs: 1500, weight: 0.9, settings: { ambiguousBelow: 0.8, timeoutMs: 3000 } }),
  )
  await expect(page.getByTestId('second-pass')).toContainText('cassette:hosted')
  const { strokeId, upAt } = await drawWall(page)
  await expect(page.getByTestId('second-asking')).toBeVisible()

  // committed on the rules' reading at the normal pause, while the model is still thinking
  const committedAfter = await page.evaluate(async (t0) => {
    while (window.__brushDev!.live().phase !== 'committed') await new Promise((r) => requestAnimationFrame(r))
    return performance.now() - t0
  }, upAt)
  expect(committedAfter).toBeLessThan(400 + 200)
  expect(await page.evaluate(() => window.__brushDev!.live().asking)).toBe(true)
  const cmds = await page.evaluate(() => window.__brush!.commands())
  expect(cmds.map((c) => c.op)).toEqual(['create_wall'])

  // the late answer arrives: a suggestion chip, the decision and the log stay as they are
  await page.waitForFunction(() => !!window.__brushDev!.live().suggestion, null, { timeout: 4000 })
  const live = await page.evaluate(() => window.__brushDev!.live())
  expect(live.strokeId).toBe(strokeId)
  expect(live.suggestion!.kind).toBe('door')
  expect(live.decision!.kind).toBe('wall')
  expect(await page.evaluate(() => window.__brush!.commands().map((c) => c.op))).toEqual(['create_wall'])
  await expect(page.getByTestId('suggestion-chip')).toHaveAttribute('data-origin', 'model')
  await expect(page.getByTestId('second-suggestion')).toContainText('door')
  const ms = await page.evaluate(() => window.__brushDev!.secondPassMs())
  expect(ms).toHaveLength(1)
  expect(ms[0]).toBeGreaterThanOrEqual(1500)
  await page.screenshot({ path: screenPath('m4-suggestion') })
})

test('M4: an answer before the commit refines the live reading and is what commits', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await page.evaluate(() =>
    window.__brushDev!.useCassetteRescorer({ probs: { furniture: 0.95, wall: 0.02 }, latencyMs: 60, weight: 0.95, settings: { ambiguousBelow: 0.8, timeoutMs: 3000 } }),
  )
  await page.evaluate(() => window.__brush!.setSetting('commitPauseMs', 800))
  await drawWall(page)
  await page.waitForFunction(() => window.__brushDev!.live().origin === 'model')
  await expect(page.locator('[data-testid="pen-chip"][data-origin="model"]').first()).toBeVisible()
  await page.waitForFunction(() => window.__brushDev!.live().phase === 'committed' || window.__brushDev!.live().phase === 'offer')
  const live = await page.evaluate(() => window.__brushDev!.live())
  if (live.phase === 'committed') {
    expect(live.decision!.kind).toBe(live.hypothesis!.kind)
    expect(live.decision!.kind).not.toBe('wall')
  } else {
    expect(live.chips).toContain('furniture') // still unsure after fusion: offered, not committed
  }
})

test('M4: Off by default — no second-pass call is made', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await expect(page.getByTestId('second-pass').getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true')
  await drawWall(page)
  await page.waitForFunction(() => window.__brushDev!.live().phase === 'committed')
  expect(await page.evaluate(() => window.__brushDev!.live().asking)).toBeFalsy()
  expect(await page.evaluate(() => window.__brushDev!.secondPassMs())).toHaveLength(0)
})
