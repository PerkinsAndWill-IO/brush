/**
 * M2 "Context" in the app: contexts built in the background for every sheet,
 * snap markers while drawing, the debug overlay of detected context, and the
 * shape-only note on scanned sheets. Screenshots: reports/screens/m2-*.png.
 */
import { expect, test } from '@playwright/test'
import { screenPath, openSidePanel } from './helpers'
import { line, openWith, replay, settle } from './m1-helpers'

const SIX = 'office-6-sheets.pdf'

test('M2: context is built for the fixture sheets (contextFor) with wall and grid items', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  for (const id of ['sheet-0', 'sheet-3']) {
    const ctx = await page.evaluate((s) => window.__brush!.contextFor(s), id)
    expect(ctx).not.toBeNull()
    expect(ctx!.sheetId).toBe(id)
    expect(ctx!.items.filter((i) => i.kind === 'wall').length).toBeGreaterThanOrEqual(10)
    expect(ctx!.items.filter((i) => i.kind === 'grid').length).toBeGreaterThanOrEqual(5)
    expect(ctx!.scale).toBe(100)
  }
  // the background pass reaches every sheet
  await page.waitForFunction(async () => {
    const all = await Promise.all(window.__brush!.sheets().map((s) => window.__brush!.contextFor(s.id)))
    return all.every((c) => c && c.items.length > 0)
  })
})

test('M2: a stroke ending ~4 pt short of a wall corner shows a snap marker at the corner', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await page.evaluate(() => window.__brush!.contextFor('sheet-0'))
  await page.evaluate(() => window.__brush!.setSetting('commitPauseMs', 1500)) // keep the live markers up while we look
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1.4))
  await settle(page)
  // along wall w0-0 (y = 120) towards its corner with w0-1 at x = 842.01, stopping 4 pt short
  await replay(page, line(SIX, 0, [620, 121], [838, 120.5], 30), true)
  const end = page.locator('[data-sheet-id="sheet-0"] [data-snap="end"]')
  await expect(end).toHaveCount(1)
  expect(Number(await end.getAttribute('data-x'))).toBeCloseTo(842.01, 0)
  expect(Number(await end.getAttribute('data-y'))).toBeCloseTo(120, 0)
  expect(await end.getAttribute('data-snap-kind')).toMatch(/intersection|endpoint/)
  // the ghost runs to the snapped corner too
  await expect(page.locator('[data-ghost="wall"]')).toHaveCount(1)
  await page.screenshot({ path: screenPath('m2-snap-marker') })

  // snapping off: no markers
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__brush!.setSetting('snapping', false))
  await replay(page, line(SIX, 0, [620, 300], [838, 124], 30), true)
  await expect(page.locator('[data-snap]')).toHaveCount(0)
})

test('M2: debug overlay draws the detected context; a scanned sheet says shape only', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await page.evaluate(() => window.__brush!.contextFor('sheet-1'))
  await openSidePanel(page)
  await page.getByTestId('section-snapping').getByRole('button', { name: /Snapping/ }).click()
  await page.getByTestId('context-overlay-toggle').click()
  await page.evaluate(() => window.__brushDev!.focusSheet(1, 1))
  await settle(page)
  const layer = page.locator('[data-sheet-id="sheet-1"] [data-layer="context"]')
  await expect(layer).toHaveCount(1)
  expect(Number(await layer.getAttribute('data-items'))).toBeGreaterThan(20)
  for (const k of ['wall', 'grid', 'label']) expect(await layer.locator(`[data-kind="${k}"]`).count()).toBeGreaterThan(0)
  await page.screenshot({ path: screenPath('m2-context-overlay') })

  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/scanned-1-sheet.pdf'))
  await expect(page.getByTestId('shape-only')).toHaveText('shape only — no context')
  await page.screenshot({ path: screenPath('m2-scanned-shape-only') })
})
