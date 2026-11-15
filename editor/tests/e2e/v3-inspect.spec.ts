/**
 * V3 inspect (docs/tasks/V3-inspect.md): with the Select tool on a `.drawing`, hovering an element highlights it on
 * every sheet it appears on and shows its data in the left sidebar; a click pins it, Esc releases it.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { openApp, screenPath, openPanel } from './helpers'

const HOUSE = fileURLToPath(new URL('../../../schema/public/examples/house.drawing', import.meta.url))
test.skip(!existsSync(HOUSE), 'needs schema/public/examples/house.drawing')

const PLANS = '382617' // A102 Plans
/** "fire place hang" (Generic Models): drawn on the plans, the elevations and the 3D view. */
const FIREPLACE = '701300'

async function openHouse(page: Page) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(HOUSE)
  await expect(page.locator(`[data-sheet-id="${PLANS}"][data-rendered="true"]`)).toBeVisible()
}

/**
 * Client point on a stroke of `el` on sheet `sheetId` that hits `el` (and not something drawn over it), found
 * through the app's own modules (Vite dev server).
 */
async function pointOn(page: Page, sheetId: string, el: string) {
  return page.evaluate(
    async ({ sheetId, el }) => {
      const load = (p: string) => import(/* @vite-ignore */ p)
      const { getDocState } = await load('/src/app/store.ts')
      const { getCamera } = await load('/src/app/camera.ts')
      const { elementAt, itemsOf } = await load('/src/app/drawing/inspect.ts')
      const st = getDocState()
      const vp = st.source.vectorPage(sheetId)
      const pl = st.placements.find((p: { sheetId: string }) => p.sheetId === sheetId)
      const cam = getCamera()
      const r = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
      for (const it of itemsOf(vp.page, [el]) as { t: string; xy: Float32Array }[]) {
        if (it.t !== 'segs' && it.t !== 'path') continue
        const step = it.t === 'segs' ? 4 : 2
        for (let k = 0; k + 3 < it.xy.length; k += step) {
          const x = (it.xy[k] + it.xy[k + 2]) / 2, y = (it.xy[k + 1] + it.xy[k + 3]) / 2
          if (elementAt(vp.page, x, y, 4 / cam.z) !== el) continue
          return { x: r.left + (x + pl.x + cam.x) * cam.z, y: r.top + (y + pl.y + cam.y) * cam.z }
        }
      }
      return null
    },
    { sheetId, el },
  )
}

test('V3-01..03: hover highlights an element on every sheet; a click selects it and its data shows in the Select sidebar', async ({ page }) => {
  await openApp(page)
  await openHouse(page)
  await page.keyboard.press('v')
  const card = page.getByTestId('left-sidebar').getByTestId('inspect-panel')
  // the element panel: nothing selected, no card (no "No element" placeholder), and the panel stays narrow
  await openPanel(page, 'element')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('left-sidebar')).not.toHaveClass(/wide/)

  // zoom on the plans so the fireplace is easy to hit
  await page.evaluate(async (id) => {
    const load = (p: string) => import(/* @vite-ignore */ p)
    const { boardView } = await load('/src/app/board/Board.tsx')
    const { getDocState } = await load('/src/app/store.ts')
    boardView.focusSheet(getDocState().sheets.find((s: { id: string }) => s.id === id).pageIndex)
  }, PLANS)
  const pt = await pointOn(page, PLANS, FIREPLACE)
  expect(pt).not.toBeNull()

  // V3-01: hover → highlighted on all three pages, but no card: the card is for a selected element
  await page.mouse.move(pt!.x, pt!.y)
  await expect(page.locator(`[data-testid="inspect-highlight"][data-element="${FIREPLACE}"]`)).toHaveCount(3)
  await expect(card).toHaveCount(0)

  // moving off the element (off the board, onto the top bar) clears the hover
  await page.mouse.move(pt!.x + 400, pt!.y + 400)
  await page.mouse.move(600, 8)
  await expect(page.getByTestId('inspect-highlight')).toHaveCount(0)

  // V3-02: a click selects (pins) it, and the panel shows the element's data
  await page.mouse.move(pt!.x, pt!.y)
  await page.mouse.down()
  await page.mouse.up()
  await expect(card).toHaveAttribute('data-element', FIREPLACE)
  await expect(card).toHaveAttribute('data-pinned', 'true')
  await expect(page.getByTestId('left-sidebar')).toHaveClass(/wide/)
  await expect(card).toContainText('Generic Models')
  await expect(card).toContainText('fire place hang')
  const general = card.locator('[data-group="general"]')
  await expect(general.locator('.prop-row', { hasText: 'elementId' })).toContainText(FIREPLACE)
  await expect(general.locator('.prop-row', { hasText: 'category' })).toContainText('Generic Models')
  // V3-03: and the sheets it appears on
  await expect(card.getByTestId('inspect-appears')).toHaveAttribute('data-count', '3')

  // hovering elsewhere keeps it; Esc releases
  await page.mouse.move(pt!.x + 300, pt!.y + 200)
  await expect(card).toHaveAttribute('data-element', FIREPLACE)
  await expect(page.locator(`[data-testid="inspect-highlight"][data-element="${FIREPLACE}"]`)).toHaveCount(3)
  await page.screenshot({ path: screenPath('v3-inspect.png') })
  await page.keyboard.press('0') // fit all: the highlight is on every sheet
  await page.screenshot({ path: screenPath('v3-inspect-all-sheets.png') })

  // V3-03: a sheet chip fits that sheet
  const x0 = await page.evaluate(() => window.__brush!.camera().x)
  await card.locator('.chip[data-sheet-id="958184"]').click()
  await expect.poll(() => page.evaluate(() => window.__brush!.camera().x)).not.toBe(x0)
  await expect(card).toHaveAttribute('data-pinned', 'true')

  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('inspect-highlight')).toHaveCount(0)

  // a drag with the Select tool pans and does not pin
  const cam0 = await page.evaluate(() => window.__brush!.camera())
  await page.mouse.move(700, 400)
  await page.mouse.down()
  await page.mouse.move(760, 440, { steps: 5 })
  await page.mouse.up()
  const cam1 = await page.evaluate(() => window.__brush!.camera())
  expect(cam1.x).not.toBe(cam0.x)
  await expect(page.locator('[data-testid="inspect-panel"][data-pinned="true"]')).toHaveCount(0)

  // the panel belongs to the Select tool
  await page.keyboard.press('b')
  await expect(card).toHaveCount(0)
  await expect(page.getByTestId('right-sidebar').getByTestId('inspect-panel')).toHaveCount(0)
})
