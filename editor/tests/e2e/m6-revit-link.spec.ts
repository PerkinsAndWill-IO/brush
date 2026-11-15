/**
 * M6: live link to Revit. The first test runs against the real Brush Link DevHost (`../revit`, needs the .NET 8
 * SDK; skipped with a message when `dotnet` is missing). The others mock the socket with routeWebSocket, to show
 * results the DevHost never produces (failed commands, notes) and the first-connect explainer of a deployed page.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { openApp, screenPath } from './helpers'
import { ROOT, line, settle } from './m1-helpers'

const REVIT = resolve(ROOT, '..', 'revit')
const PORT = 47899
const LINK = `ws://127.0.0.1:${PORT}/link`
const FIXTURE = resolve(REVIT, 'tests', 'fixtures', 'office-1-sheet.json.drawing')
const SHEET = 'A-201'

const hasDotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' }).status === 0

type RevitSnap = ReturnType<NonNullable<typeof window.__brushDev>['revit']>
const snap = (page: Page): Promise<RevitSnap> => page.evaluate(() => window.__brushDev!.revit())
const wallIds = (page: Page) =>
  page.evaluate(async (id) => {
    const ctx = await window.__brush!.contextFor(id)
    return (ctx?.items ?? []).filter((i) => i.kind === 'wall').map((i) => i.hostRef!)
  }, SHEET)
const versionOf = async (page: Page) => (await snap(page)).open.find((o) => o.id === SHEET)?.version ?? 0

async function drawWall(page: Page, from: [number, number], to: [number, number]) {
  const rec = line('revit', 0, from, to, 30)
  rec.points = rec.points.map((p, i) => ({ ...p, t: i * 9 }))
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
}

test.describe('M6 with the DevHost', () => {
  test.skip(!hasDotnet, 'M6 DevHost tests need the .NET 8 SDK (`dotnet`); install it to run them')
  let host: ChildProcessWithoutNullStreams
  let hostLog = ''

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    host = spawn('dotnet', ['run', '--project', resolve(REVIT, 'src', 'Brush.Link.DevHost'), '--', FIXTURE, '--port', String(PORT), '--allow-origin', 'http://127.0.0.1:5179'], {
      cwd: REVIT,
      stdio: 'pipe',
    })
    host.stdout.on('data', (d) => (hostLog += String(d)))
    host.stderr.on('data', (d) => (hostLog += String(d)))
    const t0 = Date.now()
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break
      } catch {
        /* not up yet */
      }
      if (host.exitCode !== null) throw new Error(`DevHost exited: ${hostLog}`)
      if (Date.now() - t0 > 200_000) throw new Error(`DevHost did not start: ${hostLog}`)
      await new Promise((r) => setTimeout(r, 300))
    }
  })

  test.afterAll(() => {
    host?.kill()
  })

  test('M6-01..M6-04, M6-06, M6-07: open a Revit sheet, a wall goes into the model and comes back as version 2; undo reverts; a Revit edit reloads', async ({ page }) => {
    test.setTimeout(90_000)
    await openApp(page)

    // M6-01: connect, welcome lists the sheets
    await page.evaluate((u) => window.__brushDev!.revitConnect(u), LINK)
    await page.waitForFunction(() => window.__brushDev!.revit().state === 'on')
    expect((await snap(page)).sheets.map((s) => s.id)).toEqual([SHEET])
    await expect(page.getByTestId('revit-start')).toBeVisible()

    // M6-02: open from Revit through the panel on the start page
    await page.screenshot({ path: screenPath('m6-start-connected') })
    await page.getByTestId('revit-open-sheet').first().click()
    await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
    expect((await page.evaluate(() => window.__brush!.sheets())).map((s) => s.id)).toEqual([SHEET])
    expect(await versionOf(page)).toBe(1)
    await expect(page.getByTestId('host-status')).toContainText('Live')
    await expect(page.getByTestId('revit-button')).toHaveAttribute('data-state', 'on')
    const walls1 = await wallIds(page)
    expect(walls1.length).toBeGreaterThan(3)

    // M6-03: draw a wall; it goes out in an apply batch with baseVersion 1
    await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
    await settle(page)
    await page.evaluate(() => window.__brush!.setSetting('mode', 'wall'))
    await drawWall(page, [300, 420], [700, 420])
    await page.waitForFunction(() => window.__brush!.commands().length === 1)
    const [cmd] = await page.evaluate(() => window.__brush!.commands())
    expect(cmd.op).toBe('create_wall')
    expect(cmd.sheetId).toBe(SHEET)
    expect(cmd.id).toMatch(/^cmd-[a-z0-9]{6}-0001$/) // a session prefix: never collides with ids Revit already applied
    const camBefore = await page.evaluate(() => window.__brush!.camera())

    // M6-04: version 2 has the wall as package context; the stroke is hidden (the sheet draws the wall now)
    await page.waitForFunction((id) => window.__brushDev!.revit().open.find((o) => o.id === id)?.version === 2, SHEET)
    await page.waitForFunction(() => window.__brushDev!.revit().hidden.length === 1)
    const s2 = await snap(page)
    const applied = s2.results.find((r) => r.id === cmd.id)!
    expect(applied).toMatchObject({ status: 'applied', landed: true })
    const newWall = applied.elementIds![0]
    await expect.poll(() => wallIds(page)).toContain(newWall)
    expect(await page.evaluate(() => window.__brush!.camera())).toEqual(camBefore) // camera kept
    expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(1) // still in the history
    await expect(page.locator('[data-layer="elements"] [data-element]')).toHaveCount(0) // element overlay hidden too
    await page.screenshot({ path: screenPath('m6-wall-applied-v2') })

    // M6-06: undo of the commit reverts it in the model → version 3 without the wall
    await page.evaluate(() => window.__brush!.undo())
    await page.waitForFunction((id) => window.__brushDev!.revit().open.find((o) => o.id === id)?.version === 3, SHEET)
    await expect.poll(() => wallIds(page)).not.toContain(newWall)
    expect((await snap(page)).hidden).toEqual([]) // the ink is back, as after any undo of a commit
    // redo applies it again (the plugin forgot the reverted id)
    await page.evaluate(() => window.__brush!.redo())
    await page.waitForFunction((id) => window.__brushDev!.revit().open.find((o) => o.id === id)?.version === 4, SHEET)
    await page.waitForFunction(() => window.__brushDev!.revit().hidden.length === 1)

    // M6-07: an edit in Revit (DevHost `rm`) pushes model_changed; a stroke not yet committed stays
    await page.evaluate(() => window.__brush!.setSetting('mode', 'markup'))
    await drawWall(page, [300, 600], [500, 650])
    const strokesBefore = await page.evaluate(() => window.__brush!.strokes().length)
    const victim = walls1[0]
    host.stdin.write(`rm ${SHEET} ${victim}\n`)
    await page.waitForFunction((id) => window.__brushDev!.revit().open.find((o) => o.id === id)?.version === 5, SHEET, { timeout: 15_000 })
    await expect.poll(() => wallIds(page)).not.toContain(victim)
    expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(strokesBefore)
    expect(await page.evaluate(() => window.__brush!.camera())).toEqual(camBefore)
    await page.screenshot({ path: screenPath('m6-model-changed-v5') })

    // the panel shows the version on screen
    await page.getByTestId('revit-button').click()
    await expect(page.getByTestId('revit-version')).toHaveText('v5')
    await page.screenshot({ path: screenPath('m6-panel') })
  })
})

// ─────────────── mocked link ───────────────

const fixturePkg = () => JSON.parse(readFileSync(FIXTURE, 'utf8')) as { sheets: { id: string }[] }

/** A scripted plugin: welcome, the fixture as the sheet, and `answer` for each apply. */
function mockPlugin(
  page: Page,
  answer: (cmds: { id: string; op: string }[]) => unknown[],
  seen: { type: string; sheetId?: string }[] = [],
  sheets: { id: string; number: string; name: string }[] = [{ id: SHEET, number: 'A-201', name: 'Level 2 Floor Plan' }],
) {
  const version = 1
  return page.routeWebSocket(/:47821\/link$/, (ws: WebSocketRoute) => {
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw))
      seen.push(m)
      const reply = (o: object) => ws.send(JSON.stringify({ requestId: m.requestId, ...o }))
      if (m.type === 'hello')
        reply({
          type: 'welcome',
          protocol: 1,
          server: { name: 'brush-revit-link', version: '0.1.0', host: 'Revit 2026', epoch: 'mock' },
          document: { title: 'Tower A' },
          sheets,
        })
      else if (m.type === 'open_sheet') reply({ type: 'sheet', sheetId: m.sheetId, version, reason: 'open', package: fixturePkg() })
      else if (m.type === 'show_sheet') reply({ type: 'shown', sheetId: m.sheetId })
      else if (m.type === 'apply') reply({ type: 'applied', sheetId: SHEET, baseVersion: m.baseVersion, stale: false, results: answer(m.commands) })
    })
  })
}

test('M6-05: a failed command shows its message on the ink; notes show as a dismissable hint', async ({ page }) => {
  let n = 0
  await mockPlugin(page, (cmds) =>
    cmds.map((c) =>
      n++ === 0
        ? { id: c.id, status: 'failed', elementIds: [], message: `${c.id}: not inside a plan viewport on this sheet` }
        : { id: c.id, status: 'applied', elementIds: ['912345'], notes: ["no wall type 'Generic - 200mm', used 'Basic Wall: Generic - 8\"'"] },
    ),
  )
  await openApp(page)
  await page.evaluate(() => window.__brushDev!.revitConnect())
  await page.waitForFunction(() => window.__brushDev!.revit().state === 'on')
  await page.evaluate((id) => window.__brushDev!.revitOpenSheet(id), SHEET)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  await page.evaluate(() => window.__brush!.setSetting('mode', 'wall'))

  await drawWall(page, [300, 420], [700, 420])
  const failed = page.locator('[data-testid="revit-result"][data-status="failed"]')
  await expect(failed).toHaveCount(1)
  await expect(failed).toContainText('not inside a plan viewport')
  await expect(failed).not.toContainText('cmd-')
  expect((await snap(page)).hidden).toEqual([]) // failed ink stays

  await drawWall(page, [300, 560], [700, 560])
  const note = page.locator('[data-testid="revit-result"][data-status="applied"]')
  await expect(note).toContainText('used ')
  await page.screenshot({ path: screenPath('m6-results-on-ink') })
  await note.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.locator('.revit-result.note')).toHaveCount(0)
  // still applied and waiting for its sheet version (the mock sends none): a quiet dot, no text
  await expect(note).toHaveClass(/pending/)
  await expect(note).not.toContainText('used ')
})

test('M6-09: opening a sheet in the editor shows it in Revit; clicking an open sheet shows it again', async ({ page }) => {
  const seen: { type: string; sheetId?: string }[] = []
  await mockPlugin(page, () => [], seen)
  await openApp(page)
  await page.evaluate(() => window.__brushDev!.revitConnect())
  await page.waitForFunction(() => window.__brushDev!.revit().state === 'on')
  await page.evaluate((id) => window.__brushDev!.revitOpenSheet(id), SHEET)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  const shown = () => seen.filter((m) => m.type === 'show_sheet').map((m) => m.sheetId)
  await expect.poll(shown).toEqual([SHEET])
  // already open: asking again does not re-open it, it only brings it up in Revit
  await page.evaluate((id) => window.__brushDev!.revitOpenSheet(id), SHEET)
  await expect.poll(shown).toEqual([SHEET, SHEET])
  expect(seen.filter((m) => m.type === 'open_sheet')).toHaveLength(1)
  expect((await snap(page)).error).toBeUndefined()
  await page.screenshot({ path: screenPath('m6-show-sheet-in-revit') })
})

test('M6-10: tick several sheets in the panel and open them together; only the first is shown in Revit', async ({ page }) => {
  const seen: { type: string; sheetId?: string }[] = []
  const sheets = [
    { id: '101', number: 'A-101', name: 'Ground Floor' },
    { id: '201', number: 'A-201', name: 'Level 2 Floor Plan' },
    { id: '301', number: 'A-301', name: 'Level 3 Floor Plan' },
  ]
  await mockPlugin(page, () => [], seen, sheets)
  await openApp(page)
  await page.evaluate(() => window.__brushDev!.revitConnect())
  await page.waitForFunction(() => window.__brushDev!.revit().state === 'on')

  const start = page.getByTestId('revit-start')
  await expect(start.getByTestId('revit-open-selected')).toHaveCount(0)
  await start.locator('li[data-sheet-id="101"]').getByTestId('revit-pick-sheet').check()
  await start.locator('li[data-sheet-id="301"]').getByTestId('revit-pick-sheet').check()
  await expect(start.getByTestId('revit-open-selected')).toHaveText('Open 2 sheets')
  await page.screenshot({ path: screenPath('m6-pick-several') })
  await start.getByTestId('revit-open-selected').click()

  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(2)
  expect((await snap(page)).open.map((o) => o.id)).toEqual(['101', '301'])
  expect(seen.filter((m) => m.type === 'open_sheet').map((m) => m.sheetId)).toEqual(['101', '301'])
  expect(seen.filter((m) => m.type === 'show_sheet').map((m) => m.sheetId)).toEqual(['101'])

  // the rest can be added the same way from the top-bar panel
  await page.getByTestId('revit-button').click()
  const panel = page.getByTestId('revit-panel')
  await expect(panel.getByTestId('revit-select-all')).toHaveCount(0) // one sheet left: no bulk bar
  await panel.locator('li[data-sheet-id="201"]').getByTestId('revit-pick-sheet').check()
  await expect(panel.getByTestId('revit-open-selected')).toHaveText('Add 1 sheet')
  await panel.getByTestId('revit-open-selected').click()
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(3)
  expect((await snap(page)).open.map((o) => o.id)).toEqual(['101', '301', '201'])
  await page.screenshot({ path: screenPath('m6-several-open') })
})

test('M6-08: a deployed (https) editor explains the local-network prompt before the first connect', async ({ page, baseURL }) => {
  const origin = 'https://brush-editor.test'
  // Serve the dev build under an https origin by proxying every request to the e2e server.
  await page.route(`${origin}/**`, async (route) => {
    const url = route.request().url().replace(origin, baseURL!)
    const res = await route.fetch({ url })
    await route.fulfill({ response: res })
  })
  await mockPlugin(page, () => [])
  await page.goto(`${origin}/`)
  await page.waitForFunction(() => !!window.__brush)
  await expect(page.getByTestId('revit-lna-explainer')).toBeVisible()
  await expect(page.getByTestId('revit-lna-explainer')).toContainText('local network')
  await expect(page.getByTestId('revit-lna-explainer')).toContainText('Allow always')
  await page.screenshot({ path: screenPath('m6-lna-explainer') })
  await page.getByTestId('revit-connect').click()
  await page.waitForFunction(() => window.__brushDev!.revit().state === 'on')
  await expect(page.getByTestId('revit-open-sheet')).toBeVisible()
  // explained once: a reload goes straight to the connect button
  await page.reload()
  await page.waitForFunction(() => !!window.__brush)
  await expect(page.getByTestId('revit-connect-start')).toBeVisible()
})

test('M6-01: Revit not running → waiting and retrying; the panel says so', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.__brushDev!.revitConnect('ws://127.0.0.1:47898/link'))
  await page.waitForFunction(() => window.__brushDev!.revit().detail?.includes('Waiting for Revit'))
  expect((await snap(page)).state).toBe('connecting')
  await expect(page.getByTestId('revit-detail')).toContainText('Waiting for Revit')
  await page.screenshot({ path: screenPath('m6-waiting') })
  await page.evaluate(() => window.__brushDev!.revitDisconnect())
  expect((await snap(page)).state).toBe('off')
})
