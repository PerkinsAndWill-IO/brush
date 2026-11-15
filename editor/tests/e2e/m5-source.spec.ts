/**
 * M5 source wiring in the app: a `.drawing` (binary format, decision 0008) opens through the
 * same flow as a PDF (file dialog), its contexts come from its host elements (origin 'package',
 * hostRef set), the brush emits commands against it, and the log exports as a command file.
 */
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { openApp, screenPath, openSidePanel } from './helpers'
import { fixturePath, line, openAppMenu, settle } from './m1-helpers'

test('M5: a .drawing package opens like a PDF; a wall stroke logs create_wall against its package context; commands export', async ({ page }) => {
  await openApp(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(fixturePath('packages/office-1-sheet.drawing'))
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  expect(sheets.map((s) => [s.id, s.number])).toEqual([['900000', 'A-201']])
  await expect(page.getByTestId('host-status')).toContainText('Package')

  const ctx = await page.evaluate(() => window.__brush!.contextFor('900000'))
  expect(ctx!.origin).toBe('package')
  const walls = ctx!.items.filter((i) => i.kind === 'wall')
  expect(walls.length).toBeGreaterThan(5)
  expect(walls.every((w) => typeof w.hostRef === 'string' && w.confidence === 1)).toBe(true)

  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  const rec = line('office-1-sheet.drawing', 0, [200, 121], [700, 120], 40)
  rec.points = rec.points.map((p, i) => ({ ...p, t: i * 9 }))
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
  await page.waitForFunction(() => window.__brush!.commands().length > 0)
  const [cmd] = await page.evaluate(() => window.__brush!.commands())
  expect(cmd.op).toBe('create_wall')
  expect(cmd.sheetId).toBe('900000')
  if (cmd.op === 'create_wall') expect(cmd.wallType).toBeTruthy() // from the package palette
  await page.screenshot({ path: screenPath('m5-package-wall') })

  const download = page.waitForEvent('download')
  await openAppMenu(page)
  await page.getByTestId('export-commands').click()
  const dl = await download
  expect(dl.suggestedFilename()).toBe('office-1-sheet.commands.json')
  const file = JSON.parse(readFileSync(await dl.path(), 'utf8'))
  expect(file.kind).toBe('brush-commands')
  expect(file.source).toMatchObject({ name: 'office-1-sheet.drawing', kind: 'package' })
  expect(file.commands).toHaveLength(1)
  expect(file.commands[0].op).toBe('create_wall')
})

test('Save to file: sidecar and command file (download fallback when File System Access is not used)', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-1-sheet.pdf'))
  await page.evaluate((r) => window.__brush!.replayStroke(r), line('office-1-sheet.pdf', 0, [200, 300], [600, 300], 20))
  const names: string[] = []
  const texts: Record<string, string> = {}
  page.on('download', async (d) => {
    names.push(d.suggestedFilename())
    texts[d.suggestedFilename()] = readFileSync(await d.path(), 'utf8')
  })
  await openAppMenu(page)
  await page.getByTestId('save-to-file').click()
  await expect(page.getByTestId('save-to-file')).toHaveText('Downloaded')
  await expect.poll(() => Object.keys(texts).sort()).toEqual(['office-1-sheet.brush.json', 'office-1-sheet.commands.json'])
  const sidecar = JSON.parse(texts['office-1-sheet.brush.json'])
  expect(sidecar.schemaVersion).toBe(1)
  expect(sidecar.strokes).toHaveLength(1)
  expect(JSON.parse(texts['office-1-sheet.commands.json']).kind).toBe('brush-commands')
  await page.screenshot({ path: screenPath('save-to-file') })
})

test('Clear session: the hamburger menu wipes strokes and commands, and the empty session survives a reload', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-1-sheet.pdf'))
  await page.evaluate((r) => window.__brush!.replayStroke(r), line('office-1-sheet.pdf', 0, [200, 300], [600, 300], 20))
  await page.evaluate((r) => window.__brush!.replayStroke(r), line('office-1-sheet.pdf', 0, [200, 400], [600, 400], 20))
  expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(2)
  await page.evaluate(() => window.__brushDev!.flushSave()) // the two strokes are in the sidecar before the clear
  await openAppMenu(page)
  await expect(page.getByTestId('app-menu')).toBeVisible()
  await page.screenshot({ path: screenPath('app-menu') })
  page.once('dialog', (d) => void d.accept())
  await page.getByTestId('clear-session').click()
  await expect(page.getByTestId('app-menu')).toHaveCount(0)
  expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(0)
  expect(await page.evaluate(() => window.__brush!.commands().length)).toBe(0)
  await openSidePanel(page)
  await expect(page.getByTestId('section-session')).toContainText('0 strokes')
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()

  // the cleared session is what autosave keeps
  await page.evaluate(() => window.__brushDev!.flushSave())
  await page.reload()
  await page.waitForFunction(() => !!window.__brush)
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-1-sheet.pdf'))
  expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(0)
})
