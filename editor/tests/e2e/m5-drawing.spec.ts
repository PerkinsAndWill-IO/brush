/**
 * Decision 0008: the binary `.drawing` format (schema/schema/drawing-format.md) opens in the editor. Pages draw from
 * the file's vectors (no PDF), contexts come from the host elements (origin 'package', hostRef), and a wall stroke
 * logs create_wall with a wall type from the model's own palette.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { openApp, screenPath } from './helpers'
import { line, settle } from './m1-helpers'

const MODEL_WALL_TYPES = ['Wall - Timber Clad', 'Interior - 165 Partition (1-hr)', 'CL_W1', 'Cavity wall_sliders', 'Foundation - 300mm Concrete', 'SH_Curtain wall', 'Interior - Partition', 'SIP 202mm Wall - conc clad']
const HOUSE = fileURLToPath(new URL('../../../schema/public/examples/house.drawing', import.meta.url))

test.skip(!existsSync(HOUSE), 'needs schema/public/examples/house.drawing')

test('M5-08: a binary .drawing opens, its pages render from vectors, contexts carry host refs, a wall stroke logs create_wall', async ({ page }) => {
  await openApp(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(HOUSE)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]').first()).toBeVisible()
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  expect(sheets.map((s) => s.number ?? s.name)).toEqual(['A102', 'A103', '{3D}'])
  expect(sheets[0].scale).toBe(100)
  await expect(page.getByTestId('host-status')).toContainText('Package · rac_basic_2026')

  // the page raster holds ink-dark vector pixels (not blank paper)
  const dark = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-sheet-id="382617"] .page canvas')
    if (!c) return -1
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) n++
    return n
  })
  expect(dark).toBeGreaterThan(1000)

  const ctx = await page.evaluate(() => window.__brush!.contextFor('382617'))
  expect(ctx!.origin).toBe('package')
  const walls = ctx!.items.filter((i) => i.kind === 'wall')
  expect(walls.length).toBeGreaterThan(30)
  expect(walls.every((w) => typeof w.hostRef === 'string' && w.confidence === 1 && Number(w.props?.thicknessPt) > 0)).toBe(true)

  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  // a long straight stroke in the empty top band of the sheet (above the plan views)
  const rec = line('house.drawing', 0, [300, 80], [900, 80], 40)
  rec.points = rec.points.map((p, i) => ({ ...p, t: i * 9 }))
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
  await page.waitForFunction(() => window.__brush!.commands().length > 0)
  const [cmd] = await page.evaluate(() => window.__brush!.commands())
  expect(cmd.sheetId).toBe('382617')
  expect(cmd.op).toBe('create_wall')
  // a type of the model (measured from its plans), not one of the built-in defaults
  if (cmd.op === 'create_wall') expect(MODEL_WALL_TYPES).toContain(cmd.wallType)
  await page.screenshot({ path: screenPath('m5-drawing-house') })
})

test('M5-08: the start page offers the schema sample drawings and opens one', async ({ page }) => {
  await openApp(page)
  const picker = page.getByTestId('sample-picker')
  await expect(picker).toBeVisible()
  await expect(picker.locator('option[value="house.drawing"]')).toHaveCount(1)
  await picker.selectOption('house.drawing')
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]').first()).toBeVisible()
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  expect(sheets.map((s) => s.number ?? s.name)).toEqual(['A102', 'A103', '{3D}'])
  await page.screenshot({ path: screenPath('m5-sample-picker-house') })
})

test('M5-08: a file opened while a sample downloads is not replaced by the late sample', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/samples/house.drawing', async (route) => {
    await held
    await route.continue()
  })
  await openApp(page)
  await page.getByTestId('sample-picker').selectOption('house.drawing')
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-1-sheet.pdf'))
  const sampleDone = page.waitForResponse('**/samples/house.drawing')
  release()
  await sampleDone
  await page.waitForTimeout(500)
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  expect(sheets.map((s) => s.number ?? s.name)).not.toContain('A102')
  expect(sheets.length).toBe(1)
  await page.screenshot({ path: screenPath('m5-sample-late-download') })
})
