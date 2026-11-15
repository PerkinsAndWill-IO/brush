import { expect, test } from '@playwright/test'
import { openApp, screenPath } from './helpers'

test('U1-01: the side panel is hidden on load; the ☰ at the top left opens and closes it, over the board', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-1-sheet.pdf'))
  const toggle = page.getByTestId('panel-toggle')
  const panel = page.getByTestId('side-panel')

  // closed by default: no sidebar on screen, the ☰ is the first thing in the top bar
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(panel).toHaveCount(0)
  await expect(page.getByTestId('left-sidebar')).toHaveCount(0)
  await expect(page.getByTestId('right-sidebar')).toHaveCount(0)
  const t = (await toggle.boundingBox())!
  const logo = (await page.locator('.brand-logo').boundingBox())!
  expect(t.x).toBeLessThan(logo.x)
  const boardWidth = async () => (await page.locator('.canvas-area').boundingBox())!.width
  const before = await boardWidth()

  // the ☰ opens one panel with every group in it, over the board (which keeps its size)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('left-sidebar')).toBeVisible()
  await expect(panel.getByTestId('right-sidebar')).toBeVisible()
  await expect(panel.getByTestId('section-mode')).toBeVisible()
  await expect(panel.getByTestId('section-session')).toBeVisible()
  expect(await boardWidth()).toBe(before)
  const p = (await panel.boundingBox())!
  expect(p.x).toBeLessThanOrEqual(1)
  // the scale bar is not under the panel
  const bar = page.getByTestId('scale-bar')
  if (await bar.count()) expect((await bar.boundingBox())!.x).toBeGreaterThanOrEqual(p.x + p.width)
  await page.screenshot({ path: screenPath('u1-01-side-panel') })

  // only the ☰ closes it again
  await panel.getByRole('button', { name: 'Wall' }).click()
  await expect(panel).toBeVisible()
  await toggle.click()
  await expect(panel).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
})
