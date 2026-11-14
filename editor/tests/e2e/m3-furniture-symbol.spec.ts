/**
 * M3-03: committed furniture takes its family's footprint and, on a `.drawing`, is drawn with the type's own plan
 * symbol (as the model draws it) instead of a tinted box. A rough stool sketched in the gap of a row of bar stools
 * is typed like its neighbours and lands square, at their size.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { StrokeRecording } from '../../src/core/types'
import { openApp, screenPath } from './helpers'
import { settle } from './m1-helpers'

const HOUSE = fileURLToPath(new URL('../../../schema/public/examples/house.drawing', import.meta.url))
test.skip(!existsSync(HOUSE), 'needs schema/public/examples/house.drawing')

test('M3-03: a stool sketched in a row of bar stools commits as one more of them, drawn with their symbol', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.__brush!.setSetting('live', true))
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(HOUSE)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]').first()).toBeVisible()
  const ctx = (await page.evaluate(() => window.__brush!.contextFor('382617')))!

  // the bar stools, and the widest gap between two neighbours in their row
  const stools = ctx.items
    .filter((i) => i.kind === 'fixture' && i.props?.typeName === 'Bar Chair')
    .map((i) => {
      const xs = i.geometry.points.map((p) => p.x)
      const ys = i.geometry.points.map((p) => p.y)
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, s: Math.max(...xs) - Math.min(...xs) }
    })
  expect(stools.length).toBeGreaterThanOrEqual(3)
  const row = stools.filter((s) => Math.abs(s.y - stools[0].y) < 2).sort((a, b) => a.x - b.x)
  let gap = { at: { x: row[row.length - 1].x + 2 * row[0].s, y: row[0].y }, w: 0 }
  for (let i = 0; i + 1 < row.length; i++) {
    const w = row[i + 1].x - row[i].x
    if (w > gap.w) gap = { at: { x: (row[i].x + row[i + 1].x) / 2, y: (row[i].y + row[i + 1].y) / 2 }, w }
  }
  const size = row[0].s

  // zoom in on the gap so the symbol can be judged
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  await page.evaluate(
    ({ q, z }) => {
      const b = window.__brush!
      const cam = b.camera()
      const sheet = document.querySelector('[data-sheet-id="382617"]')!.getBoundingClientRect()
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
      // sheet point -> board coords through the current camera
      const bx = (sheet.left - board.left + q.x * cam.z) / cam.z - cam.x
      const by = (sheet.top - board.top + q.y * cam.z) / cam.z - cam.y
      b.setSetting('camera', { x: board.width / 2 / z - bx, y: board.height / 2 / z - by, z })
    },
    { q: gap.at, z: 14 },
  )
  await settle(page)

  // a wobbly, slightly tilted loop about 0.85 the stool's size: how a quick stool sketch comes out
  const n = 40
  const points = Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * 2 * Math.PI
    const r = (size * 0.85) / 2 * (1 + 0.12 * Math.sin(3 * a) + 0.05 * Math.cos(5 * a))
    return { x: gap.at.x + r * Math.cos(a + 0.35) * 1.05, y: gap.at.y + r * Math.sin(a + 0.35) * 0.95, t: i * 12 }
  })
  const rec: StrokeRecording = { pdf: 'house.drawing', sheet: 0, label: { kind: 'furniture' }, points }
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
  await page.waitForFunction(() => window.__brush!.commands().length > 0, null, { timeout: 5000 })
  const [cmd] = await page.evaluate(() => window.__brush!.commands())
  expect(cmd.op).toBe('place_instance')
  if (cmd.op !== 'place_instance') return
  expect(cmd.family).toBe('Bar Chair')
  // square to the sheet, at the stools' own size
  expect(Math.abs(Math.sin(2 * cmd.angleRad))).toBeLessThan(1e-3) // square (to the sheet or a wall a hair off it)
  expect(cmd.bbox.w).toBeGreaterThan(size * 0.9)
  expect(cmd.bbox.w).toBeLessThan(size * 1.1)

  const el = page.locator('[data-element="furniture"] [data-kind="furniture"]')
  await expect(el).toHaveAttribute('data-symbol', 'Bar Chair')
  await page.screenshot({ path: screenPath('m3-furniture-symbol') })
})
