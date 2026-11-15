/**
 * Loading mark (M1-03, M5-08): while the app waits on a file it shows the Brush
 * logo with its letters dispersing and regrouping in a loop (src/app/ui/BrushLoader.tsx).
 */
import { expect, test } from '@playwright/test'
import { openApp, screenPath } from './helpers'

test('M5-08: downloading a sample shows the dispersing logo on the start page, then the board', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/samples/house.drawing', async (route) => {
    await held
    await route.continue()
  })
  await openApp(page)
  await expect(page.getByTestId('brush-loader')).toHaveCount(0)
  await page.getByTestId('sample-picker').selectOption('house.drawing')
  const loader = page.getByTestId('empty-state').getByTestId('brush-loader')
  await expect(loader).toBeVisible()
  await expect(loader).toHaveAttribute('aria-label', /house\.drawing/)
  // five letters, each animated
  const letters = loader.locator('.brush-loader-letter')
  await expect(letters).toHaveCount(5)
  expect(await letters.first().evaluate((e) => getComputedStyle(e).animationName)).toBe('brush-disperse')
  await page.waitForTimeout(900) // mid-cycle: letters are apart
  await page.screenshot({ path: screenPath('loading-mark-start-page') })
  release()
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]').first()).toBeVisible()
})

test('M1-03: a sheet that is not painted yet shows the dispersing logo in its placeholder', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => void window.__brush!.loadPdf('/fixtures/pdfs/office-6-sheets.pdf'))
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet"]').length === 6)
  const placeholders = await page.evaluate(() => [...document.querySelectorAll('.placeholder')].map((p) => !!p.querySelector('[data-testid="brush-loader"]')))
  expect(placeholders.every(Boolean)).toBe(true)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet"][data-rendered="true"]').length === 6)
  await expect(page.locator('.placeholder')).toHaveCount(0)
})
