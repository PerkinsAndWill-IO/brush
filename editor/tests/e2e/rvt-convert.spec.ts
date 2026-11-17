/**
 * Opening a Revit model needs the conversion server (CLAUDE.md), which is not deployed. Without it the start page
 * says so up front and a `.rvt` picked anyway gets the same plain message; PDFs and samples still open.
 */
import { expect, test, type Page } from '@playwright/test'
import { openApp, screenPath } from './helpers'

const CONVERT_URL = 'http://127.0.0.1:4100/convert'
const UNAVAILABLE = 'Opening Revit models (.rvt) isn’t available yet. You can open a sample or upload a PDF.'

async function chooseRvt(page: Page) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles({ name: 'Tower A.rvt', mimeType: 'application/octet-stream', buffer: Buffer.from('not really a revit model') })
}

test('no conversion server: the start page says .rvt is not available and offers samples and PDFs', async ({ page }) => {
  await page.route(CONVERT_URL, (r) => r.abort('connectionrefused'))
  await openApp(page)
  await expect(page.getByRole('heading', { name: 'Drop a PDF or .drawing to start' })).toBeVisible()
  await expect(page.getByTestId('rvt-unavailable')).toHaveText(UNAVAILABLE)
  await expect(page.getByTestId('sample-picker').getByRole('button').first()).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Choose file' })).toBeEnabled()
  await page.screenshot({ path: screenPath('rvt-convert-unavailable') })

  await chooseRvt(page)
  await expect(page.getByTestId('load-error')).toHaveText(UNAVAILABLE)
  await expect(page.getByTestId('rvt-unavailable')).toHaveCount(0) // said once, in the error
  await page.screenshot({ path: screenPath('rvt-convert-unavailable-picked') })
})

test('conversion server up: the start page offers .rvt', async ({ page }) => {
  await page.route(CONVERT_URL, (r) => r.fulfill({ status: 405 }))
  await openApp(page)
  await expect(page.getByRole('heading', { name: 'Drop a PDF, .rvt or .drawing to start' })).toBeVisible()
  await expect(page.getByTestId('rvt-unavailable')).toHaveCount(0)
})

test('conversion server gone after the check: a picked .rvt gets the plain message', async ({ page }) => {
  let up = true
  await page.route(CONVERT_URL, (r) => (up ? r.fulfill({ status: 405 }) : r.abort('connectionrefused')))
  await openApp(page)
  await expect(page.getByRole('heading', { name: 'Drop a PDF, .rvt or .drawing to start' })).toBeVisible()
  up = false
  await chooseRvt(page)
  await expect(page.getByTestId('load-error')).toHaveText(UNAVAILABLE)
  await expect(page.getByRole('heading', { name: 'Drop a PDF or .drawing to start' })).toBeVisible()
})
