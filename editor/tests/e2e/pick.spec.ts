/**
 * Select tool on a binary `.drawing`: hovering an element highlights it on an overlay layer and shows its card
 * (name, category, id, parameters from the document's `elements` table); a click pins the card; Esc or a click on
 * empty paper unpins it. The point to hover is found with the same core hit index the app builds, from the file itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { buildHitIndex, hitTest, parseDrawingPayload } from '../../src/core/drawing'
import { openApp, screenPath } from './helpers'
import { settle } from './m1-helpers'

const HOUSE = fileURLToPath(new URL('../../../schema/public/examples/house.drawing', import.meta.url))

test.skip(!existsSync(HOUSE), 'needs schema/public/examples/house.drawing')

const doc = parseDrawingPayload(new Uint8Array(gunzipSync(readFileSync(HOUSE))))
const plan = doc.pages[0] // sheet A102, the first sheet on the board
const index = buildHitIndex(plan, (s, em) => s.length * em * 0.5)

/** Sheet points where the topmost item at a 4 px radius belongs to a named door, with the door's id and name. */
function doorPoints(tolPt: number) {
  const out: { x: number; y: number; el: string; name: string }[] = []
  plan.items.forEach((it, i) => {
    if (it.t !== 'segs' || it.el === null || doc.elements[it.el]?.category !== 'Doors' || !doc.elements[it.el].name) return
    for (let k = 0; k + 3 < it.xy.length && out.length < 200; k += 4) {
      const x = (it.xy[k] + it.xy[k + 2]) / 2
      const y = (it.xy[k + 1] + it.xy[k + 3]) / 2
      if (hitTest(index, x, y, tolPt) === i) out.push({ x, y, el: it.el, name: doc.elements[it.el].name! })
    }
  })
  return out
}

async function openHouse(page: Page) {
  await openApp(page)
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(HOUSE)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]').first()).toBeVisible()
  await page.evaluate(() => window.__brush!.setTool('select'))
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
}

/** Screen position of a sheet point, if the board (not a bar or the tool capsule) is what lies there. */
async function screenOf(page: Page, p: { x: number; y: number }) {
  const sheet = plan.sizePt
  return page.evaluate(
    ([x, y, w]) => {
      const r = document.querySelector('[data-testid="sheet"] .paper')!.getBoundingClientRect()
      const sx = r.left + (x * r.width) / w
      const sy = r.top + (y * r.width) / w
      const top = document.elementFromPoint(sx, sy)
      return top && document.querySelector('[data-testid="board"]')!.contains(top) ? { x: sx, y: sy } : null
    },
    [p.x, p.y, sheet.w] as const,
  )
}

async function doorInView(page: Page, z: number) {
  for (const door of doorPoints(4 / z)) {
    const at = await screenOf(page, door)
    if (at) return { door, at }
  }
  throw new Error('no door in view')
}

/** A spot on the sheet where nothing is drawn, as the app would see it. */
async function emptyPaperInView(page: Page, z: number) {
  for (let y = 10; y < plan.sizePt.h; y += 60)
    for (let x = 10; x < plan.sizePt.w; x += 60) {
      if (hitTest(index, x, y, 8 / z) >= 0) continue
      const at = await screenOf(page, { x, y })
      if (at) return at
    }
  throw new Error('no empty paper in view')
}

const pickCanvasHasInk = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="sheet"] canvas.pick-canvas')!
    if (c.width < 2) return false
    return c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0)
  })

test('hovering a door highlights it and shows its card, a click pins it, Esc and empty paper unpin', async ({ page }) => {
  await openHouse(page)
  const z = (await page.evaluate(() => window.__brush!.camera())).z
  expect(doorPoints(4 / z).length).toBeGreaterThan(10)

  // the sheet's raster is not re-rendered by picking
  await page.evaluate(() => document.querySelector('[data-testid="sheet"] .page canvas')!.setAttribute('data-keep', '1'))

  const { door, at } = await doorInView(page, z)
  const emptyAt = await emptyPaperInView(page, z)

  const card = page.getByTestId('pick-card')
  await page.mouse.move(emptyAt.x, emptyAt.y)
  await expect(card).toHaveCount(0)
  await page.mouse.move(at.x, at.y, { steps: 3 })
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-element', door.el)
  await expect(card).toHaveAttribute('data-pinned', 'false')
  await expect(card.locator('.name')).toHaveText(door.name)
  await expect(card.locator('.cat')).toHaveText('Doors')
  await expect(card).toContainText(`Element id: ${door.el}`)
  await expect.poll(() => pickCanvasHasInk(page)).toBe(true)
  expect(await page.evaluate(() => document.querySelector('[data-testid="sheet"] .page canvas')!.getAttribute('data-keep'))).toBe('1')
  await page.screenshot({ path: screenPath('pick-hover-house') })

  // moving off every item clears the hover and the highlight
  await page.mouse.move(emptyAt.x, emptyAt.y)
  await expect(card).toHaveCount(0)
  await expect.poll(() => pickCanvasHasInk(page)).toBe(false)

  // click pins the card; moving away does not change it
  await page.mouse.move(at.x, at.y)
  await expect(card).toBeVisible()
  await page.mouse.down()
  await page.mouse.up()
  await expect(card).toHaveAttribute('data-pinned', 'true')
  await expect(card).toContainText('Pinned.')
  await page.mouse.move(at.x + 120, at.y + 60)
  await expect(card).toHaveAttribute('data-element', door.el)
  await expect.poll(() => pickCanvasHasInk(page)).toBe(true)
  await page.screenshot({ path: screenPath('pick-pinned-house') })

  // Esc unpins
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  await expect.poll(() => pickCanvasHasInk(page)).toBe(false)

  // clicking empty paper unpins too
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.up()
  await expect(card).toHaveAttribute('data-pinned', 'true')
  await page.mouse.move(emptyAt.x, emptyAt.y)
  await page.mouse.down()
  await page.mouse.up()
  await expect(card).toHaveCount(0)
})

test('the pen is not picking: with the brush tool hovering shows no card', async ({ page }) => {
  await openHouse(page)
  await page.evaluate(() => window.__brush!.setTool('brush'))
  const { at } = await doorInView(page, (await page.evaluate(() => window.__brush!.camera())).z)
  await page.mouse.move(at.x, at.y, { steps: 3 })
  await page.waitForTimeout(150)
  await expect(page.getByTestId('pick-card')).toHaveCount(0)
})
