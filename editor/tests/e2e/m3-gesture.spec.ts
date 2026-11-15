/**
 * M3-11 in the app: strokes drawn close in time and space are read together as
 * one gesture (e.g. a stool sketched as a seat in two arcs plus a cross), so the
 * Reading panel and "This session" show one reading instead of one per stroke.
 * Screenshot: m3-gesture-done.png.
 */
import { expect, test, type Page } from '@playwright/test'
import type { StrokeRecording } from '../../src/core/types'
import { screenPath, openSidePanel } from './helpers'
import { openWith, readRecording, settle } from './m1-helpers'

const SIX = 'office-6-sheets.pdf'

/** The corpus furniture circle, cut into pieces, plus a short cross stroke inside it. */
function stoolPieces(): StrokeRecording[] {
  const seat = readRecording('furniture/furniture-000.json')
  const pts = seat.points
  const cut = Math.floor(pts.length / 2)
  const piece = (from: number, to: number): StrokeRecording => {
    const p = pts.slice(from, to)
    return { ...seat, points: p.map((q) => ({ ...q, t: q.t - p[0].t })) }
  }
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const cross: StrokeRecording = {
    ...seat,
    points: Array.from({ length: 12 }, (_, i) => ({ x: cx - 8 + (16 * i) / 11, y: cy - 8 + (16 * i) / 11, t: i * 10, p: 0.5 })),
  }
  return [piece(0, cut + 1), piece(cut, pts.length), cross]
}

/** Replay strokes in real time with `gapMs` between pen-up and the next pen-down; returns their ids and whether the group box showed. */
async function drawGesture(page: Page, recs: StrokeRecording[], gapMs: number) {
  return page.evaluate(
    async ([rs, gap]) => {
      const ids: string[] = []
      let boxSeen = 0
      for (let i = 0; i < rs.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, gap))
        await window.__brush!.replayStroke(rs[i], { realtime: true })
        ids.push(window.__brushDev!.live().strokeId!)
        const box = document.querySelector('[data-gesture-box]')
        if (box) boxSeen = Math.max(boxSeen, Number(box.getAttribute('data-gesture-box')))
      }
      return { ids, boxSeen }
    },
    [recs, gapMs] as const,
  )
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
  await page.evaluate(() => window.__brush!.contextFor('sheet-1'))
  await page.evaluate(() => window.__brushDev!.focusSheet(1, 1))
  await settle(page)
}

for (const gap of [250, 600]) {
  test(`M3-11: a stool sketched in three strokes ${gap} ms apart is read as one gesture`, async ({ page }) => {
    await prepare(page)
    const { ids, boxSeen } = await drawGesture(page, stoolPieces(), gap)
    expect(new Set(ids).size).toBe(3)
    const last = ids[2]
    await waitDone(page, last)
    if (gap === 250) await page.screenshot({ path: screenPath('m3-gesture-done') })

    const live = await page.evaluate(() => window.__brushDev!.live())
    expect(live.gesture).toEqual(ids)
    expect(live.gestures[last]).toEqual(ids)
    expect(boxSeen).toBe(3) // after the last pen-up the dashed box surrounds all three strokes

    // one reading: the whole seat was read (furniture), and nothing was committed for the pieces on their own
    const accepted = await page.evaluate(() => window.__brushDev!.accepted() as { strokeId: string }[])
    expect(accepted.filter((a) => ids.includes(a.strokeId)).map((a) => a.strokeId)).toEqual(live.phase === 'committed' ? [last] : [])
    expect(live.phase === 'committed' ? live.decision?.kind : live.hypothesis?.kind).toBe('furniture')

    // "This session" folds the gesture into one row
    await openSidePanel(page)
    const rows = page.locator('[data-testid="session-list"] li[data-stroke-id]')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveAttribute('data-stroke-id', last)
    await expect(rows.first()).toHaveAttribute('data-strokes', '3')
  })
}

test('M3-11: a stroke far away, or after a long pause, starts a new reading', async ({ page }) => {
  await prepare(page)
  const [a, b] = stoolPieces()
  const far: StrokeRecording = { ...b, points: b.points.map((p) => ({ ...p, x: p.x - 300 })) }
  const near = await drawGesture(page, [a, far], 250)
  await waitDone(page, near.ids[1])
  let live = await page.evaluate(() => window.__brushDev!.live())
  expect(live.gesture).toEqual([near.ids[1]])

  const late = await drawGesture(page, [a, b], 1600)
  await waitDone(page, late.ids[1])
  live = await page.evaluate(() => window.__brushDev!.live())
  expect(live.gesture).toEqual([late.ids[1]])
  expect(Object.keys(live.gestures)).toHaveLength(0)
})
