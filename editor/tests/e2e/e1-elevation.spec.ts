import { expect, test, type Page } from '@playwright/test'
import type { StrokeRecording } from '../../src/core/types'
import { openApp, screenPath } from './helpers'

// Real KRO bundle: sheet 2 is the north elevation (typed by its drawing code "-ELE-"). Decision 0006.
const KRO = '/fixtures/pdfs/kro-project-3-sheets.pdf'

test.setTimeout(180_000)

const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

test('E1-02, E1-04, E1-05: on the KRO elevation an upright door-sized rectangle becomes a door drawn face on', async ({ page }) => {
  await openApp(page)
  await page.evaluate((url) => window.__brush!.loadPdf(url), KRO)
  const sheet = await page.evaluate(() => window.__brush!.sheets()[1])
  expect(sheet.number).toContain('-ELE-')
  const ctx = await page.evaluate((id) => window.__brush!.contextFor(id), sheet.id)
  expect(ctx?.items.find((i) => i.props?.role === 'sheet-info')?.props?.sheetType).toBe('elevation')

  // somewhere on the facade, middle of the sheet; 1:100 → 28.35 pt per metre
  const ptPerM = (1000 / 100 / 25.4) * 72
  const at = { x: sheet.sizePt.w * 0.5, y: sheet.sizePt.h * 0.55 }
  await page.evaluate(
    ({ id, q, z }) => {
      const b = window.__brush!
      const cam = b.camera()
      const el = document.querySelector(`[data-sheet-id="${id}"]`)!.getBoundingClientRect()
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
      const bx = (el.left - board.left + q.x * cam.z) / cam.z - cam.x
      const by = (el.top - board.top + q.y * cam.z) / cam.z - cam.y
      b.setSetting('camera', { x: board.width / 2 / z - bx, y: board.height / 2 / z - by, z })
    },
    { id: sheet.id, q: at, z: 6 },
  )
  await settle(page)

  // a hand-drawn 0.93 x 2.0 m outline, slightly wobbly, closed back near its start
  const w = 0.93 * ptPerM
  const h = 2.0 * ptPerM
  const x0 = at.x - w / 2
  const floor = at.y + h / 2
  const verts = [
    { x: x0, y: floor },
    { x: x0 + 1, y: floor - h },
    { x: x0 + w, y: floor - h + 0.8 },
    { x: x0 + w - 0.6, y: floor },
    { x: x0 + 0.5, y: floor - 0.4 },
  ]
  const points: StrokeRecording['points'] = []
  let t = 0
  for (let i = 0; i + 1 < verts.length; i++) {
    const a = verts[i]
    const b = verts[i + 1]
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2)
    for (let k = i === 0 ? 0 : 1; k <= n; k++) points.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, t: (t += 10), p: 0.5 })
  }
  const rec: StrokeRecording = { pdf: 'kro-project-3-sheets.pdf', sheet: 1, label: { kind: 'door' }, points }
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
  await page.waitForFunction(() => window.__brush!.commands().length > 0, null, { timeout: 10_000 })

  const last = await page.evaluate(() => window.__brush!.hypotheses().at(-1))
  expect(last?.kind).toBe('door')
  expect(last?.geometry.closed).toBe(true)
  expect(last?.evidence?.some((e) => e.startsWith('elevation sheet'))).toBe(true)
  const [cmd] = await page.evaluate(() => window.__brush!.commands())
  expect(cmd.op).toBe('place_door')
  if (cmd.op !== 'place_door') return
  expect(cmd.familyType).toBe('Single-Flush 0900x2100')
  expect(cmd.widthPt / ptPerM).toBeCloseTo(0.9, 2)
  expect(cmd.at.y).toBeCloseTo(floor, 0)
  await expect(page.locator('[data-element="door"] [data-kind="door"]')).toHaveCount(1)
  await settle(page)
  await page.screenshot({ path: screenPath('e1-elevation-door') })
})
