/**
 * V2 display filters (docs/tasks/V2-drawing-filters.md): on a binary `.drawing`, the Filters section lists the
 * file's categories; unticking one, or hiding an item kind, re-renders the pages without those items. Remembered
 * per browser. Not shown for PDFs.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { openApp, screenPath, openPanel } from './helpers'

const HOUSE = fileURLToPath(new URL('../../../schema/public/examples/house.drawing', import.meta.url))
test.skip(!existsSync(HOUSE), 'needs schema/public/examples/house.drawing')

const SHEET = '[data-sheet-id="382617"]'

async function openHouse(page: Page) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(HOUSE)
  await expect(page.locator(`${SHEET}[data-rendered="true"]`)).toBeVisible()
}

/** Non-white pixels on the sheet's page raster. */
const inked = (page: Page) =>
  page.evaluate((sel) => {
    const c = document.querySelector<HTMLCanvasElement>(`${sel} .page canvas`)
    if (!c) return -1
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++
    return n
  }, SHEET)

async function rerendered(page: Page, after: string) {
  await expect.poll(() => page.locator(SHEET).getAttribute('data-filter-version')).not.toBe(after)
}

test('V2-01..03: filters list the categories, hide categories and kinds, and survive a reload', async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId('section-filters')).toHaveCount(0) // nothing open: no filters
  await openHouse(page)
  await openPanel(page, 'filters')
  const section = page.getByTestId('right-sidebar').getByTestId('section-filters')
  await expect(section).toBeVisible()
  // Rooms are hidden by default (they lie under everything and get in the way of picking)
  const rooms = section.locator('input[data-category="Rooms"]')
  if (await rooms.count()) await expect(rooms).not.toBeChecked()
  const walls = section.locator('input[data-category="Walls"]')
  await expect(walls).toBeChecked()
  await expect(section.locator('input[data-category="Grids"]')).toBeVisible()
  const all = await inked(page)
  expect(all).toBeGreaterThan(1000)

  // V2-01: untick Walls → fewer inked pixels
  let v = (await page.locator(SHEET).getAttribute('data-filter-version'))!
  await walls.uncheck()
  await rerendered(page, v)
  const noWalls = await inked(page)
  expect(noWalls).toBeLessThan(all)

  // V2-02: hide fills on top
  v = (await page.locator(SHEET).getAttribute('data-filter-version'))!
  await section.locator('[data-kind="fills"]').click()
  await expect(section.locator('[data-kind="fills"]')).toHaveAttribute('aria-pressed', 'false')
  await rerendered(page, v)
  expect(await inked(page)).toBeLessThan(noWalls)

  // V2-03: hide annotation ticks off Grids and Title Blocks, leaves Doors
  await section.getByTestId('filter-annotation').click()
  await expect(section.locator('input[data-category="Grids"]')).not.toBeChecked()
  await expect(section.locator('input[data-category="Title Blocks"]')).not.toBeChecked()
  await expect(section.locator('input[data-category="Doors"]')).toBeChecked()
  await section.scrollIntoViewIfNeeded()
  await page.screenshot({ path: screenPath('v2-drawing-filters.png') })

  // remembered per browser
  await page.reload()
  await openHouse(page)
  await openPanel(page, 'filters')
  await expect(page.getByTestId('section-filters').locator('input[data-category="Walls"]')).not.toBeChecked()
  await expect(page.getByTestId('section-filters').locator('[data-kind="fills"]')).toHaveAttribute('aria-pressed', 'false')

  // Show all brings everything back
  v = (await page.locator(SHEET).getAttribute('data-filter-version'))!
  await page.getByTestId('filter-reset').click()
  await expect(page.getByTestId('section-filters').locator('input[data-category="Walls"]')).toBeChecked()
  await rerendered(page, v)
  // everything: what was shown at first, and the rooms hidden by default
  expect(await inked(page)).toBeGreaterThanOrEqual(all)
})
