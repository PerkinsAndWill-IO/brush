/**
 * M0 smoke: launch headless, load a fixture PDF through window.__brush,
 * assert on data, save a screenshot. Also one smoke per pinned library
 * (pdf.js, tldraw) per the spec risk table.
 */
import { expect, test } from '@playwright/test'
import { openApp, recordPerf, screenPath } from './helpers'

test('M0: empty state renders', async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose file' })).toBeVisible()
  await page.screenshot({ path: screenPath('m0-empty') })
})

test('M0: loadPdf renders the 1-sheet fixture (pdf.js smoke)', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-1-sheet.pdf'))
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  expect(sheets).toHaveLength(1)
  expect(sheets[0].sizePt.w).toBeGreaterThan(0)
  expect(sheets[0].sizePt.h).toBeGreaterThan(0)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  // canvas really has ink on it (not a blank white page)
  const nonWhite = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="sheet"] canvas')!
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) n++
    return n
  })
  expect(nonWhite).toBeGreaterThan(100)
  await page.screenshot({ path: screenPath('m0-smoke'), fullPage: true })
})

test('M0: 6-sheet fixture loads all pages; first sheet visible timing', async ({ page }) => {
  await openApp(page)
  const ms = await page.evaluate(async () => {
    const t0 = performance.now()
    await window.__brush!.loadPdf('/fixtures/pdfs/office-6-sheets.pdf')
    return performance.now() - t0
  })
  expect(await page.evaluate(() => window.__brush!.sheets().length)).toBe(6)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(6)
  recordPerf({ firstSheetVisibleMs: ms })
  await page.screenshot({ path: screenPath('m0-six-sheets'), fullPage: true })
})

test('M0: corrupt PDF keeps the empty state with an inline error', async ({ page }) => {
  await openApp(page)
  const err = await page.evaluate(() =>
    window.__brush!.loadPdf('/fixtures/pdfs/corrupt.pdf').then(
      () => null,
      (e: Error) => e.message,
    ),
  )
  expect(err).not.toBeNull()
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await expect(page.getByTestId('load-error')).toBeVisible()
  await page.screenshot({ path: screenPath('m0-corrupt') })
})

test('M0: tldraw mounts (library smoke)', async ({ page }) => {
  await page.goto('/?smoke=tldraw')
  await page.waitForFunction(() => window.__tldrawSmoke?.mounted === true)
  expect(await page.evaluate(() => window.__tldrawSmoke!.shapeCount)).toBe(1)
  await expect(page.locator('.tl-container')).toBeVisible()
  await page.screenshot({ path: screenPath('m0-tldraw') })
})
