/**
 * V1 view aids (docs/tasks/V1-view-aids.md), ported from the chSpace viewer:
 * scale bar, Measure tool, metric grid, label size, live screen-constant overlays.
 * Screenshots: reports/screens/v1-*.png.
 */
import { expect, test, type Page } from '@playwright/test'
import { screenPath, openSidePanel } from './helpers'
import { boardCenter, camera, openWith, settle } from './m1-helpers'

const ONE = 'office-1-sheet.pdf'
const PT_PER_M_1_100 = 2834.645669 / 100

async function openScaled(page: Page) {
  await openWith(page, ONE)
  const ctx = await page.evaluate(() => window.__brush!.contextFor('sheet-0'))
  expect(ctx!.scale).toBe(100)
  await page.evaluate(() => window.__brush!.setSetting('snapping', false))
}

async function openView(page: Page) {
  await openSidePanel(page)
  const section = page.getByTestId('section-view')
  if ((await section.getAttribute('data-open')) !== 'true') await section.getByRole('button', { name: 'View' }).click()
}

test('V1-01: a graphic scale bar follows the zoom and the sheet scale', async ({ page }) => {
  await openScaled(page)
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  const bar = page.getByTestId('scale-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('data-scale', '100')
  await expect(bar).toContainText('1:100')
  const check = async () => {
    const z = (await camera(page)).z
    const metres = Number(await bar.getAttribute('data-metres'))
    const w = (await bar.locator('.scale-bar').boundingBox())!.width
    // the bar is exactly `metres` long at this zoom (±2 px for the border)
    expect(Math.abs(w - metres * PT_PER_M_1_100 * z)).toBeLessThan(3)
    return metres
  }
  const before = await check()
  for (let i = 0; i < 6; i++) await page.keyboard.press('=') // zoom in ×3.8 about the middle
  await settle(page)
  const after = await check()
  expect(after).toBeLessThan(before)
  await page.screenshot({ path: screenPath('v1-01-scale-bar') })

  await openView(page)
  await page.getByTestId('scale-bar-toggle').click()
  await expect(bar).toHaveCount(0)
})

test('V1-02: the Measure tool measures in real units, drag or click-click; Backspace and Escape', async ({ page }) => {
  await openScaled(page)
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 2))
  await settle(page)
  await page.keyboard.press('m')
  await expect(page.getByTestId('tool-capsule').locator('[data-tool="measure"]')).toHaveAttribute('aria-pressed', 'true')
  await openSidePanel(page)
  await expect(page.getByTestId('section-measure')).toBeVisible()

  const { x, y } = await boardCenter(page)
  const z = (await camera(page)).z
  // drag 200 px → 200 / z pt on the sheet
  await page.mouse.move(x - 100, y)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 5 })
  await page.mouse.move(x + 100, y, { steps: 5 })
  await page.mouse.up()
  const m = page.getByTestId('measurement')
  await expect(m).toHaveCount(1)
  const want = 200 / z / PT_PER_M_1_100
  expect(Math.abs(Number(await m.first().getAttribute('data-metres')) - want)).toBeLessThan(0.02)

  // click, move, click: a second measurement, 150 px down
  await page.mouse.click(x - 100, y + 40)
  await page.mouse.move(x - 100, y + 190, { steps: 4 })
  await expect(page.getByTestId('measurement-draft')).toHaveCount(1)
  await page.mouse.click(x - 100, y + 190)
  await expect(m).toHaveCount(2)
  expect(Math.abs(Number(await m.nth(1).getAttribute('data-metres')) - 150 / z / PT_PER_M_1_100)).toBeLessThan(0.02)
  await expect(page.getByTestId('measure-list').locator('li')).toHaveCount(2)
  await page.screenshot({ path: screenPath('v1-02-measure') })

  // Escape drops a half-drawn one; Backspace removes the last; nothing goes to the session
  await page.mouse.click(x + 50, y + 80)
  await page.keyboard.press('Escape')
  await expect(m).toHaveCount(2)
  await page.keyboard.press('Backspace')
  await expect(m).toHaveCount(1)
  expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(0)
  await page.getByTestId('measure-clear').click()
  await expect(m).toHaveCount(0)
})

test('V1-03: a metric grid can be shown on scaled sheets; its spacing adapts to the zoom', async ({ page }) => {
  await openScaled(page)
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  await expect(page.getByTestId('sheet-grid')).toHaveCount(0)
  await openView(page)
  await page.getByTestId('grid-toggle').click()
  const grid = page.getByTestId('sheet-grid')
  await expect(grid).toHaveCount(1)
  await page.getByTestId('panel-toggle').click() // close the panel: the grid setting stays on
  // start zoomed out: with no sidebars the sheet fits at a zoom where the grid is already as fine as this sheet allows
  for (let i = 0; i < 4; i++) await page.keyboard.press('-')
  await settle(page)
  const coarse = Number(await grid.getAttribute('data-minor-m'))
  for (let i = 0; i < 8; i++) await page.keyboard.press('=') // zoom in ×6 about the middle
  await settle(page)
  const fine = Number(await grid.getAttribute('data-minor-m'))
  expect(fine).toBeLessThan(coarse)
  await page.screenshot({ path: screenPath('v1-03-grid') })
  // the setting is remembered across reloads
  await openScaled(page)
  await expect(page.getByTestId('sheet-grid')).toHaveCount(1)
  await openView(page)
  await page.getByTestId('grid-toggle').click()
})

test('V1-04: label size scales on-board text independently of the zoom', async ({ page }) => {
  await openScaled(page)
  await settle(page)
  const label = page.getByTestId('sheet-label').first()
  const size = () => label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const base = await size()
  await openView(page)
  await page.getByTestId('label-size').getByRole('radio', { name: 'XL' }).click()
  expect((await size()) / base).toBeCloseTo(1.45, 2)
  await page.screenshot({ path: screenPath('v1-04-label-size') })
  await page.getByTestId('label-size').getByRole('radio', { name: 'M' }).click()
  expect((await size()) / base).toBeCloseTo(1, 2)
})

test('V1-05: overlays keep their screen size during a zoom, not only after it settles', async ({ page }) => {
  await openScaled(page)
  await settle(page)
  const { x, y } = await boardCenter(page)
  await page.mouse.move(x, y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await page.evaluate(() => window.__brushDev!.frames(1))
  const read = () =>
    page.evaluate(() => ({
      z: window.__brush!.camera().z,
      overlay: parseFloat(document.querySelector<SVGElement>('svg.overlay')!.style.getPropertyValue('--z')),
      world: parseFloat(document.querySelector<HTMLElement>('.world')!.style.getPropertyValue('--z')),
    }))
  const mid = await read()
  // mid-gesture: the overlay already has the new zoom, the rest of the world still the old one
  expect(mid.overlay).toBeCloseTo(mid.z, 6)
  expect(mid.world).not.toBeCloseTo(mid.z, 6)
  await settle(page)
  const done = await read()
  expect(done.world).toBeCloseTo(done.z, 6)
})
