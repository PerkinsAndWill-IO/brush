/**
 * M6-11: opening a file of the model that is open in Revit connects the link by itself and swaps in the live sheets.
 * M6-12: streaming edits to Revit can be paused; edits wait and go out on "Send now" or when it is turned back on.
 * The plugin is mocked with routeWebSocket, and its health endpoint with route, so no Revit or DevHost is needed.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { openApp, screenPath } from './helpers'
import { ROOT, line, settle } from './m1-helpers'

const FIXTURE = resolve(ROOT, '..', 'revit', 'tests', 'fixtures', 'office-1-sheet.json.drawing')
const SHEET = 'A-201'
const fixtureBytes = () => readFileSync(FIXTURE)

type Msg = { type: string; sheetId?: string; commands?: { id: string }[]; commandIds?: string[] }
const snap = (page: Page) => page.evaluate(() => window.__brushDev!.revit())

/** A scripted plugin with "Tower A" open in Revit. Health answers too, so the editor sees Revit running. */
async function mockRevit(page: Page, seen: Msg[], title = 'Tower A', sheets = [{ id: SHEET, number: 'A-201', name: 'Level 2 Floor Plan' }]) {
  await page.route('http://127.0.0.1:47821/health', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"name":"brush-revit-link","protocol":1}' }))
  await page.routeWebSocket(/:47821\/link$/, (ws: WebSocketRoute) => {
    let version = 1
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw))
      seen.push(m)
      const reply = (o: object) => ws.send(JSON.stringify({ requestId: m.requestId, ...o }))
      if (m.type === 'hello')
        reply({
          type: 'welcome',
          protocol: 1,
          server: { name: 'brush-revit-link', version: '0.1.0', host: 'Revit 2026', epoch: 'mock' },
          document: { title, path: `C:\\Projects\\${title}.rvt` },
          sheets,
        })
      else if (m.type === 'open_sheet') reply({ type: 'sheet', sheetId: m.sheetId, version, reason: 'open', package: JSON.parse(fixtureBytes().toString('utf8')) })
      else if (m.type === 'show_sheet') reply({ type: 'shown', sheetId: m.sheetId })
      else if (m.type === 'apply') {
        reply({ type: 'applied', sheetId: m.sheetId, baseVersion: m.baseVersion, stale: false, results: m.commands.map((c: { id: string }) => ({ id: c.id, status: 'applied', elementIds: ['9'] })) })
        reply({ type: 'sheet', sheetId: m.sheetId, version: ++version, reason: 'apply', package: JSON.parse(fixtureBytes().toString('utf8')) })
      }
    })
  })
}

async function chooseFile(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer })
}

async function drawWall(page: Page, y: number) {
  const rec = line('revit', 0, [300, y], [700, y], 30)
  rec.points = rec.points.map((p, i) => ({ ...p, t: i * 9 }))
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
}

test('M6-11: a .drawing of the model open in Revit connects by itself and opens its sheets live', async ({ page }) => {
  const seen: Msg[] = []
  await mockRevit(page, seen)
  await openApp(page)
  await chooseFile(page, 'Tower A.drawing', fixtureBytes())
  await page.waitForFunction(() => window.__brushDev!.revit().open.length === 1)
  const s = await snap(page)
  expect(s.state).toBe('on')
  expect(s.open).toEqual([{ id: SHEET, version: 1 }])
  expect(s.autoNote).toContain('Tower A.drawing is open in Revit')
  expect(seen.filter((m) => m.type === 'open_sheet').map((m) => m.sheetId)).toEqual([SHEET])
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  await expect(page.getByTestId('revit-button')).toContainText('Revit · A-201')
  await page.getByTestId('revit-button').click()
  await expect(page.getByTestId('revit-auto-note')).toBeVisible()
  await page.screenshot({ path: screenPath('m6-11-auto-connected') })
})

test('M6-11: a file of another model leaves the link off', async ({ page }) => {
  const seen: Msg[] = []
  await mockRevit(page, seen, 'Some Other Model', [{ id: '777001', number: 'A-201', name: 'Level 2 Floor Plan' }])
  await openApp(page)
  await chooseFile(page, 'Unrelated.drawing', fixtureBytes())
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  // it looked (hello sent), saw another model, and hung up
  await expect.poll(() => seen.some((m) => m.type === 'hello')).toBe(true)
  await page.waitForFunction(() => window.__brushDev!.revit().state === 'off')
  expect(seen.filter((m) => m.type === 'open_sheet')).toHaveLength(0)
  expect((await snap(page)).autoNote).toBeUndefined()
})

test('M6-11: a .rvt that is open in Revit skips the conversion server and lists its sheets', async ({ page }) => {
  const seen: Msg[] = []
  let converted = 0
  await page.route('http://127.0.0.1:4100/convert', (r) => (converted++, r.fulfill({ status: 500, body: 'should not be called' })))
  await mockRevit(page, seen)
  await openApp(page)
  await chooseFile(page, 'Tower A.rvt', Buffer.from('not really a revit model'))
  await page.waitForFunction(() => window.__brushDev!.revit().state === 'on')
  await expect(page.getByTestId('revit-start').getByTestId('revit-auto-note')).toContainText('Tower A.rvt is open in Revit')
  await expect(page.getByTestId('revit-start').getByTestId('revit-pick-sheet')).toBeVisible()
  expect(converted).toBe(0)
  await page.screenshot({ path: screenPath('m6-11-rvt-open-in-revit') })
})

test('M6-12: with streaming off, edits wait; "Send now" and turning it back on send them', async ({ page }) => {
  const seen: Msg[] = []
  await mockRevit(page, seen)
  await openApp(page)
  await chooseFile(page, 'Tower A.drawing', fixtureBytes())
  await page.waitForFunction(() => window.__brushDev!.revit().open.length === 1)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  await page.evaluate(() => window.__brush!.setSetting('mode', 'wall'))

  await page.getByTestId('revit-button').click()
  await page.getByTestId('revit-stream-toggle').click()
  await expect(page.getByTestId('revit-stream-toggle')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('revit-button').click() // close the panel to draw

  const applies = () => seen.filter((m) => m.type === 'apply').length
  await drawWall(page, 420)
  await page.waitForFunction(() => window.__brushDev!.revit().queued === 1)
  await page.waitForTimeout(600) // past the debounce: still nothing sent
  expect(applies()).toBe(0)
  await expect(page.getByTestId('revit-button')).toContainText('paused · 1')

  await page.getByTestId('revit-button').click()
  await expect(page.getByTestId('revit-queued')).toHaveText('1 edit waiting')
  await page.screenshot({ path: screenPath('m6-12-streaming-paused') })
  await page.getByTestId('revit-send-now').click()
  await expect.poll(applies).toBe(1)
  await page.waitForFunction(() => window.__brushDev!.revit().queued === 0)
  await page.getByTestId('revit-button').click()

  // still paused: the next wall waits, then goes out when streaming is turned back on
  await drawWall(page, 560)
  await page.waitForFunction(() => window.__brushDev!.revit().queued === 1)
  expect(applies()).toBe(1)
  await page.getByTestId('revit-button').click()
  await page.getByTestId('revit-stream-toggle').click()
  await expect.poll(applies).toBe(2)
  expect((await snap(page)).streaming).toBe(true)

  // the choice is remembered
  await page.getByTestId('revit-stream-toggle').click()
  await page.reload()
  await page.waitForFunction(() => !!window.__brushDev)
  expect((await snap(page)).streaming).toBe(false)
})
