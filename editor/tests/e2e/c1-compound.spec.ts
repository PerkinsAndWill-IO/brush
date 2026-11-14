/**
 * C1 compound edits in the app: a wall sketched in this session is context for the next stroke, so a door drawn
 * on the new wall is hosted in it (place_door.hostWallRef = the wall's command id), whether the door comes after
 * the wall committed or during its commit pause. Screenshot: c1-door-in-new-wall.png.
 */
import { expect, test, type Page } from '@playwright/test'
import type { Command, StrokeRecording } from '../../src/core/types'
import { screenPath } from './helpers'
import { openWith, settle } from './m1-helpers'

const SIX = 'office-6-sheets.pdf'
const SHEET = 1

/**
 * A 5 m run down (or up) from a long horizontal wall of the sheet into open floor: no other wall within 25 pt of
 * it. Found at run time from the sheet's own context, so the test does not hard-code fixture coordinates.
 */
async function openSpot(page: Page) {
  return page.evaluate(async (sheet) => {
    const ctx = (await window.__brush!.contextFor(`sheet-${sheet}`))!
    const ptPerM = (1000 / (ctx.scale ?? 100) / 25.4) * 72
    const size = window.__brush!.sheets()[sheet].sizePt
    const walls = ctx.items.filter((i) => i.kind === 'wall')
    const segs = walls.flatMap((w) => w.geometry.points.slice(1).map((b, k) => ({ id: w.id, a: w.geometry.points[k], b })))
    const distSeg = (p: { x: number; y: number }, s: (typeof segs)[number]) => {
      const dx = s.b.x - s.a.x
      const dy = s.b.y - s.a.y
      const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (dx * dx + dy * dy || 1)))
      return Math.hypot(p.x - s.a.x - t * dx, p.y - s.a.y - t * dy)
    }
    const len = 5 * ptPerM
    for (const s of segs) {
      if (Math.abs(s.b.y - s.a.y) > 1 || Math.abs(s.b.x - s.a.x) < 3 * ptPerM) continue
      for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) {
        for (const dir of [1, -1]) {
          const x = s.a.x + (s.b.x - s.a.x) * f
          const y0 = s.a.y
          const y1 = y0 + dir * len
          if (y1 < 20 || y1 > size.h - 20) continue
          const free = Array.from({ length: 20 }, (_, i) => ({ x, y: y0 + dir * (30 + ((len - 30) * i) / 19) })).every((p) => segs.every((o) => distSeg(p, o) > 25))
          if (free) return { x, y0, y1, ptPerM }
        }
      }
    }
    return null
  }, SHEET)
}

const rec = (pts: { x: number; y: number }[], kind: 'wall' | 'door'): StrokeRecording => ({ pdf: SIX, sheet: SHEET, label: { kind }, points: pts.map((p, i) => ({ ...p, t: i * 12, p: 0.5 })) })

function strokesAt(spot: NonNullable<Awaited<ReturnType<typeof openSpot>>>) {
  const { x, y0, y1, ptPerM } = spot
  const wall = rec(Array.from({ length: 40 }, (_, i) => ({ x: x + 0.4 * Math.sin(i / 5), y: y0 + ((y1 - y0) * i) / 39 })), 'wall')
  const ym = (y0 + y1) / 2
  const half = 0.45 * ptPerM
  const door = rec(Array.from({ length: 14 }, (_, i) => ({ x: x - half + (2 * half * i) / 13, y: ym + 0.3 * (i / 13) })), 'door')
  return { wall, door }
}

async function drawAndWait(page: Page, r: StrokeRecording) {
  await page.evaluate((x) => window.__brush!.replayStroke(x, { realtime: true }), r)
  const id = await page.evaluate(() => window.__brushDev!.live().strokeId!)
  return id
}

const waitDone = (page: Page, strokeId: string) =>
  page.waitForFunction(
    (id) => {
      const l = window.__brushDev!.live()
      return l.strokeId === id && ['committed', 'markup', 'offer'].includes(l.phase)
    },
    strokeId,
    { timeout: 5000 },
  )

async function prepare(page: Page) {
  await openWith(page, SIX, { live: true })
  const spot = await openSpot(page)
  expect(spot, 'an open run of floor beside a wall on the fixture sheet').not.toBeNull()
  await page.evaluate((i) => window.__brushDev!.focusSheet(i, 1), SHEET)
  await settle(page)
  return strokesAt(spot!)
}

const newCommands = (page: Page) => page.evaluate(() => window.__brush!.commands()) as Promise<Command[]>

test('C1-01: a door drawn on a wall sketched a moment ago is hosted in that wall', async ({ page }) => {
  const { wall, door } = await prepare(page)
  const wallId = await drawAndWait(page, wall)
  await waitDone(page, wallId)
  const doorId = await drawAndWait(page, door)
  await waitDone(page, doorId)
  await page.screenshot({ path: screenPath('c1-door-in-new-wall') })

  const cmds = await newCommands(page)
  expect(cmds.map((c) => c.op)).toEqual(['create_wall', 'place_door'])
  const [w, d] = cmds
  expect(d.op === 'place_door' && d.hostWallRef).toBe(w.id)
})

test('C1-01: a door drawn during the new wall\'s commit pause is its own element, hosted in the wall', async ({ page }) => {
  const { wall, door } = await prepare(page)
  const wallId = await drawAndWait(page, wall)
  // well inside the commit pause and the gesture window (M3-11): without C1 the door would join the wall
  await page.evaluate(() => new Promise((r) => setTimeout(r, 120)))
  const doorId = await drawAndWait(page, door)
  expect(doorId).not.toBe(wallId)
  await waitDone(page, doorId)

  const cmds = await newCommands(page)
  expect(cmds.map((c) => c.op)).toEqual(['create_wall', 'place_door'])
  expect(cmds[0].strokeId).toBe(wallId)
  expect(cmds[1].op === 'place_door' && cmds[1].hostWallRef).toBe(cmds[0].id)
  const live = await page.evaluate(() => window.__brushDev!.live())
  expect(live.gesture).toEqual([doorId])
})
