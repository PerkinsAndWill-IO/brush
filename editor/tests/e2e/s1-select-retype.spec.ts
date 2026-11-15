/**
 * S1 select and change type (docs/tasks/S1-select-and-retype.md): with the Select tool, a click selects a drawn
 * element or a host element of a `.drawing` sheet, Shift+click adds one, and a right click opens the type menu.
 * Screenshots: s1-menu-drawn.png, s1-menu-sheet.png.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import type { Command } from '../../src/core/types'
import { openApp, screenPath } from './helpers'
import { line, openWith, settle } from './m1-helpers'

const SIX = 'office-6-sheets.pdf'
const SHEET = 1

/** Client point of sheet point `p` on `sheetId`. */
const toClient = (page: Page, sheetId: string, p: { x: number; y: number }) =>
  page.evaluate(
    async ({ sheetId, p }) => {
      const load = (m: string) => import(/* @vite-ignore */ m)
      const { getDocState } = await load('/src/app/store.ts')
      const pl = getDocState().placements.find((x: { sheetId: string }) => x.sheetId === sheetId)
      const cam = window.__brush!.camera()
      const r = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
      return { x: r.left + (p.x + pl.x + cam.x) * cam.z, y: r.top + (p.y + pl.y + cam.y) * cam.z }
    },
    { sheetId, p },
  )

const commands = (page: Page) => page.evaluate(() => window.__brush!.commands()) as Promise<Command[]>

/** Draw a straight stroke read as `kind` (forced, so the test does not depend on the brush's reading). */
async function drawAs(page: Page, kind: 'wall' | 'markup', from: [number, number], to: [number, number]) {
  await page.evaluate((k) => window.__brush!.setSetting('mode', k), kind)
  const n = (await commands(page)).length
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), line(SIX, SHEET, from, to, 30))
  if (kind === 'markup') await page.waitForTimeout(700)
  else await page.waitForFunction((m) => window.__brush!.commands().length > m, n, { timeout: 5000 })
  await page.evaluate(() => window.__brush!.setSetting('mode', 'auto'))
  return page.evaluate(() => window.__brush!.strokes().at(-1)!.id)
}

test('S1-01/02/05: select a drawn wall, read it as a door from the right-click menu, give it another type, undo', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await page.evaluate((i) => window.__brushDev!.focusSheet(i, 1), SHEET)
  await settle(page)
  const sheetId = `sheet-${SHEET}`
  const size = await page.evaluate((i) => window.__brush!.sheets()[i].sizePt, SHEET)
  const y = size.h * 0.55
  const x0 = size.w * 0.3
  const x1 = size.w * 0.45
  const wallStroke = await drawAs(page, 'wall', [x0, y], [x1, y])
  const before = await commands(page)
  expect(before.at(-1)?.op).toBe('create_wall')

  // S1-01: the Select tool selects it with a click
  await page.keyboard.press('v')
  const at = await toClient(page, sheetId, { x: (x0 + x1) / 2, y })
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(`[data-testid="selected-drawn"][data-stroke-id="${wallStroke}"]`)).toHaveCount(1)

  // S1-02: right click → the menu reads "Wall · <type>", offers the kinds and the wall types
  await page.mouse.click(at.x, at.y, { button: 'right' })
  const menu = page.getByTestId('type-menu')
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('type-menu-title')).toContainText('Wall')
  await expect(menu.locator('button[data-kind="wall"]')).toHaveAttribute('aria-checked', 'true')
  const types = menu.getByTestId('type-menu-types').locator('button')
  expect(await types.count()).toBeGreaterThan(1)
  await page.screenshot({ path: screenPath('s1-menu-drawn') })

  // another wall type: the element and its command take it
  const other = (await types.evaluateAll((bs) => bs.map((b) => [b.getAttribute('data-type'), b.getAttribute('aria-checked')]))).find(([, c]) => c !== 'true')![0]!
  await menu.locator(`button[data-type="${other}"]`).click()
  await expect(menu).toBeHidden()
  let cmds = await commands(page)
  const wall = cmds.find((c) => c.strokeId === wallStroke)!
  expect(wall.op === 'create_wall' && wall.wallType).toBe(other)
  expect(cmds).toHaveLength(before.length)

  // read as a door: one place_door replaces the wall's command
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await menu.locator('button[data-kind="door"]').click()
  cmds = await commands(page)
  expect(cmds.filter((c) => c.strokeId === wallStroke).map((c) => c.op)).toEqual(['place_door'])

  // S1-05: each change is one undo step
  await page.keyboard.press('Control+z')
  cmds = await commands(page)
  expect(cmds.filter((c) => c.strokeId === wallStroke).map((c) => c.op)).toEqual(['create_wall'])
  await page.keyboard.press('Control+z')
  expect((await commands(page)).find((c) => c.strokeId === wallStroke)).toEqual(before.at(-1))

  // markup ink can be made an element, and an element can go back to markup
  const note = await drawAs(page, 'markup', [x0, y + 120], [x1, y + 120])
  expect((await commands(page)).some((c) => c.strokeId === note)).toBe(false)
  const at2 = await toClient(page, sheetId, { x: (x0 + x1) / 2, y: y + 120 })
  await page.mouse.click(at2.x, at2.y, { button: 'right' })
  await expect(menu.locator('button[data-kind="markup"]')).toHaveAttribute('aria-checked', 'true')
  await expect(menu.getByTestId('type-menu-types')).toHaveCount(0)
  await menu.locator('button[data-kind="wall"]').click()
  expect((await commands(page)).filter((c) => c.strokeId === note).map((c) => c.op)).toEqual(['create_wall'])
  await page.mouse.click(at2.x, at2.y, { button: 'right' })
  await menu.locator('button[data-kind="markup"]').click()
  expect((await commands(page)).some((c) => c.strokeId === note)).toBe(false)

  // Shift+click adds the other element; the menu then names both. Esc closes the menu, then clears the selection.
  await page.mouse.click(at.x, at.y)
  await page.keyboard.down('Shift')
  await page.mouse.click(at2.x, at2.y)
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('selected-drawn')).toHaveCount(2)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await expect(page.getByTestId('type-menu-title')).toContainText('2 elements')
  await expect(menu.locator('button[aria-checked="true"]')).toHaveCount(0) // a wall and a markup stroke: no common kind
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('selected-drawn')).toHaveCount(0)
})

const HOUSE = fileURLToPath(new URL('../../../schema/public/examples/house.drawing', import.meta.url))
const PLANS = '382617' // A102 Plans

test('S1-03/04: give a wall on a .drawing sheet another type; it is marked on the sheet and logged as set_type', async ({ page }) => {
  test.skip(!existsSync(HOUSE), 'needs schema/public/examples/house.drawing')
  await openApp(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(HOUSE)
  await expect(page.locator(`[data-sheet-id="${PLANS}"][data-rendered="true"]`)).toBeVisible()
  await page.keyboard.press('v')

  // two walls of the plan, with a point on each that picks it
  const found = await page.evaluate(async (sheetId) => {
    const load = (p: string) => import(/* @vite-ignore */ p)
    const { getDocState } = await load('/src/app/store.ts')
    const { boardView } = await load('/src/app/board/Board.tsx')
    const { getCamera } = await load('/src/app/camera.ts')
    const { elementAt, itemsOf, pageHitIndex } = await load('/src/app/drawing/inspect.ts')
    const st = getDocState()
    boardView.focusSheet(st.sheets.find((s: { id: string }) => s.id === sheetId).pageIndex)
    await new Promise((r) => setTimeout(r, 300))
    const vp = st.source.vectorPage(sheetId)
    pageHitIndex(vp.page)
    const pl = st.placements.find((p: { sheetId: string }) => p.sheetId === sheetId)
    const cam = getCamera()
    const r = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
    const out: { id: string; type: string; x: number; y: number }[] = []
    for (const [id, el] of Object.entries(vp.elements) as [string, { category?: string; type?: string }][]) {
      if (el.category !== 'Walls' || !el.type) continue
      for (const it of itemsOf(vp.page, [id]) as { t: string; xy: Float32Array }[]) {
        if (it.t !== 'segs' && it.t !== 'path') continue
        const x = (it.xy[0] + it.xy[2]) / 2
        const y = (it.xy[1] + it.xy[3]) / 2
        const cx = r.left + (x + pl.x + cam.x) * cam.z
        const cy = r.top + (y + pl.y + cam.y) * cam.z
        if (cx < r.left + 20 || cy < r.top + 20 || cx > r.right - 20 || cy > r.bottom - 20) continue
        if (elementAt(vp.page, x, y, 4 / cam.z) !== id) continue
        out.push({ id, type: el.type, x: cx, y: cy })
        break
      }
      if (out.length === 2) break
    }
    return out
  }, PLANS)
  expect(found.length, 'two walls to pick on the plan').toBe(2)
  const [a, b] = found

  await page.mouse.click(a.x, a.y)
  await page.keyboard.down('Shift')
  await page.mouse.click(b.x, b.y)
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('selected-sheet').first()).toHaveAttribute('data-items', `${a.id},${b.id}`)

  await page.mouse.click(b.x, b.y, { button: 'right' })
  const menu = page.getByTestId('type-menu')
  await expect(page.getByTestId('type-menu-title')).toContainText('Walls · 2 elements')
  await expect(menu.locator('button[data-kind]')).toHaveCount(0) // host elements are not read again, only retyped
  const opts = await menu.getByTestId('type-menu-types').locator('button').evaluateAll((bs) => bs.map((x) => x.getAttribute('data-type')!))
  const target = opts.find((o) => o !== a.type && o !== b.type)
  test.skip(!target, 'the house has no third wall type')
  await page.screenshot({ path: screenPath('s1-menu-sheet') })
  await menu.locator(`button[data-type="${target}"]`).click()

  const cmds = (await commands(page)).filter((c) => c.op === 'set_type')
  expect(cmds.map((c) => c.op === 'set_type' && c.targets).sort()).toEqual([[a.id], [b.id]].sort())
  expect(cmds.every((c) => c.op === 'set_type' && c.typeName === target && c.strokeId === `type:${c.targets[0]}`)).toBe(true)
  await expect(page.locator(`[data-testid="type-mark"][data-element="${a.id}"]`).first()).toHaveAttribute('data-type', target!)

  // back to the original type: the pending change for that wall goes
  await page.mouse.click(a.x, a.y)
  await page.mouse.click(a.x, a.y, { button: 'right' })
  await expect(menu.locator(`button[data-type="${a.type}"] .mono-num`)).toHaveText('original')
  await menu.locator(`button[data-type="${a.type}"]`).click()
  expect((await commands(page)).filter((c) => c.op === 'set_type' && c.targets[0] === a.id)).toHaveLength(0)
  await expect(page.locator(`[data-testid="type-mark"][data-element="${a.id}"]`)).toHaveCount(0)
  expect(await page.locator(`[data-testid="type-mark"][data-element="${b.id}"]`).count()).toBeGreaterThan(0)
})
