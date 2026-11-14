/**
 * M3-03: a committed wall on a `.drawing` looks like the walls already on the sheet: the type of the walls it joins,
 * at that type's thickness, drawn with the type's own faces and layer lines (wallStylesFromDrawing), and ending at
 * the faces of the walls it joins instead of running over their linework. The command keeps the centreline geometry.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { ContextItem, StrokeRecording } from '../../src/core/types'
import { openApp, screenPath } from './helpers'
import { settle } from './m1-helpers'

const HOUSE = fileURLToPath(new URL('../../../schema/public/examples/house.drawing', import.meta.url))
test.skip(!existsSync(HOUSE), 'needs schema/public/examples/house.drawing')

interface Run {
  item: ContextItem
  y: number
  x0: number
  x1: number
  t: number
}

test('M3-03: a wall sketched between two walls commits as their type, drawn with their linework, joined at their faces', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.__brush!.setSetting('live', true))
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(HOUSE)
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]').first()).toBeVisible()
  const ctx = (await page.evaluate(() => window.__brush!.contextFor('382617')))!

  // two horizontal walls of one type, 1.5 to 5 m apart, overlapping along x, with no wall crossing between them
  const walls = ctx.items.filter((i) => i.kind === 'wall')
  const runs: Run[] = walls
    .map((item) => {
      const [a, b] = item.geometry.points
      return { item, y: (a.y + b.y) / 2, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), t: Number(item.props!.thicknessPt), dy: Math.abs(a.y - b.y) }
    })
    .filter((r) => r.dy < 0.5 && r.x1 - r.x0 > 40)
  const ptPerM = (1000 / 100 / 25.4) * 72
  let pick: { top: Run; bottom: Run; x: number } | undefined
  for (const top of runs)
    for (const bottom of runs) {
      const gap = bottom.y - top.y
      if (top.item.props!.typeName !== bottom.item.props!.typeName || gap < 1.5 * ptPerM || gap > 5 * ptPerM) continue
      const lo = Math.max(top.x0, bottom.x0) + 15
      const hi = Math.min(top.x1, bottom.x1) - 15
      if (hi - lo < 10) continue
      const x = (lo + hi) / 2
      const clear = walls.every((w) => {
        if (w === top.item || w === bottom.item) return true
        const xs = w.geometry.points.map((p) => p.x)
        const ys = w.geometry.points.map((p) => p.y)
        const crossesX = Math.min(...xs) - 15 < x && Math.max(...xs) + 15 > x
        const between = Math.max(...ys) > top.y + 2 && Math.min(...ys) < bottom.y - 2
        return !(crossesX && between)
      })
      if (clear && (!pick || gap < pick.bottom.y - pick.top.y)) pick = { top, bottom, x }
    }
  expect(pick, 'two facing walls of one type').toBeDefined()
  const { top, bottom, x } = pick!
  const type = top.item.props!.typeName

  // zoom in on the new wall's upper join
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  const focus = { x, y: top.y + Math.min(60, (bottom.y - top.y) / 2) }
  await page.evaluate(
    ({ q, z }) => {
      const b = window.__brush!
      const cam = b.camera()
      const sheet = document.querySelector('[data-sheet-id="382617"]')!.getBoundingClientRect()
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
      const bx = (sheet.left - board.left + q.x * cam.z) / cam.z - cam.x
      const by = (sheet.top - board.top + q.y * cam.z) / cam.z - cam.y
      b.setSetting('camera', { x: board.width / 2 / z - bx, y: board.height / 2 / z - by, z })
    },
    { q: focus, z: 7 },
  )
  await settle(page)

  // a slightly wobbly vertical line from one wall to the other, ends a little off their centrelines
  const n = 30
  const points = Array.from({ length: n + 1 }, (_, i) => {
    const s = i / n
    return { x: x + 1.2 * Math.sin(s * 5) + (s - 0.5) * 1.5, y: top.y + 1.5 + s * (bottom.y - top.y - 2.5), t: i * 14 }
  })
  const rec: StrokeRecording = { pdf: 'house.drawing', sheet: 0, label: { kind: 'wall' }, points }
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
  await page.waitForFunction(() => window.__brush!.commands().length > 0, null, { timeout: 5000 })
  const [cmd] = await page.evaluate(() => window.__brush!.commands())
  expect(cmd.op).toBe('create_wall')
  if (cmd.op !== 'create_wall') return
  expect(cmd.wallType).toBe(type)
  // the command still runs centreline to centreline
  const [p0, p1] = [cmd.path.points[0], cmd.path.points[cmd.path.points.length - 1]]
  expect(Math.abs(p0.y - top.y)).toBeLessThan(0.6)
  expect(Math.abs(p1.y - bottom.y)).toBeLessThan(0.6)

  // drawn as the type: its thickness, its faces and layer lines, joined to both walls (no free-end caps)
  const el = page.locator('[data-element="wall"] [data-kind="wall"] > g')
  await expect(el).toHaveAttribute('data-wall-style', type!)
  const thick = Number(await el.getAttribute('data-thickness-pt'))
  expect(thick).toBeGreaterThan(top.t * 0.85)
  expect(thick).toBeLessThan(top.t * 1.1)
  await expect(el.locator('[data-part="face"]')).toHaveCount(2)
  expect(Number(await el.getAttribute('data-lines'))).toBeGreaterThanOrEqual(2)
  expect((await el.getAttribute('data-joined'))!.split(' ').sort()).toEqual([top.item.id, bottom.item.id].sort())
  await expect(el.locator('[data-part="cap"]')).toHaveCount(0)
  // the faces stop at the host faces, not at their centrelines
  const faceYs = await el.locator('[data-part="face"]').first().getAttribute('d')
  const ys = [...faceYs!.matchAll(/[ML][\d.-]+ ([\d.-]+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
  expect(ys[0]).toBeGreaterThan(top.y + top.t * 0.35)
  expect(ys[ys.length - 1]).toBeLessThan(bottom.y - bottom.t * 0.35)

  await page.screenshot({ path: screenPath('m3-wall-style') })

  // close up on the upper join, next to the host's own linework
  await page.evaluate(
    ({ q, z }) => {
      const b = window.__brush!
      const cam = b.camera()
      const sheet = document.querySelector('[data-sheet-id="382617"]')!.getBoundingClientRect()
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
      const bx = (sheet.left - board.left + q.x * cam.z) / cam.z - cam.x
      const by = (sheet.top - board.top + q.y * cam.z) / cam.z - cam.y
      b.setSetting('camera', { x: board.width / 2 / z - bx, y: board.height / 2 / z - by, z })
    },
    { q: { x: p0.x, y: p0.y + 6 }, z: 40 },
  )
  await settle(page)
  await page.screenshot({ path: screenPath('m3-wall-style-join') })
})
