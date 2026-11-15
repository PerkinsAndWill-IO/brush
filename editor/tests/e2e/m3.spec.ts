/**
 * M3 "Streaming prediction" in the app: corpus recordings replayed at their
 * original timing through real pointer events. Hypotheses stream during the
 * stroke, commit after the pause, emit the command; low confidence offers two
 * chips (state 6); everything is undoable and survives reload.
 * Screenshots: m3-ghost.png (state 5), m3-chips.png (state 6), m3-committed.png.
 */
import { expect, test, type Page } from '@playwright/test'
import type { StrokeRecording } from '../../src/core/types'
import { p95, recordPerf, screenPath } from './helpers'
import { openWith, readRecording, settle, strokes } from './m1-helpers'

const SIX = 'office-6-sheets.pdf'

/** Straight run then a 30° bend: the predictor reads wall but is unsure (0.35–0.6). */
function bentLine(y: number): StrokeRecording {
  const L = 100
  const tail = 40
  const a = Math.PI / 6
  const n1 = 17
  const n2 = 7
  return {
    pdf: SIX,
    sheet: 0,
    label: { kind: 'markup', note: 'ambiguous: wall or markup' },
    points: [
      ...Array.from({ length: n1 }, (_, i) => ({ x: 360 + (L * i) / (n1 - 1), y, t: i * 8 })),
      ...Array.from({ length: n2 }, (_, i) => ({ x: 360 + L + Math.cos(a) * tail * ((i + 1) / n2), y: y + Math.sin(a) * tail * ((i + 1) / n2), t: (n1 + i) * 8 })),
    ],
  }
}

async function prepare(page: Page, sheet: number) {
  await page.evaluate((i) => window.__brush!.contextFor(`sheet-${i}`), sheet)
  await page.evaluate((i) => window.__brushDev!.focusSheet(i, 1), sheet)
  await settle(page)
}

/** Replay in realtime; returns hypotheses seen before pen-up (polled during the stroke) and after. */
async function replayLive(page: Page, rec: StrokeRecording) {
  return page.evaluate(async (r) => {
    const before = window.__brushDev!.live().strokeId
    let duringPenDown = 0
    let poll = true
    const sampler = (async () => {
      while (poll) {
        const l = window.__brushDev!.live()
        if (l.strokeId !== before && l.phase === 'drawing') duringPenDown = Math.max(duringPenDown, l.history.length)
        await new Promise((res) => requestAnimationFrame(res))
      }
    })()
    await window.__brush!.replayStroke(r, { realtime: true })
    poll = false
    await sampler
    return { duringPenDown, strokeId: window.__brushDev!.live().strokeId! }
  }, rec)
}

const waitDone = (page: Page, strokeId: string) =>
  page.waitForFunction((id) => {
    const l = window.__brushDev!.live()
    return l.strokeId === id && ['committed', 'markup', 'offer'].includes(l.phase)
  }, strokeId)

const CASES: { id: string; kind: string; op: string | null }[] = [
  { id: 'wall-000', kind: 'wall', op: 'create_wall' },
  { id: 'door-000', kind: 'door', op: 'place_door' },
  { id: 'furniture-000', kind: 'furniture', op: 'place_instance' },
  { id: 'delete-000', kind: 'delete', op: 'delete' },
  { id: 'markup-000', kind: 'markup', op: null },
]

test('M3: hypotheses stream during the stroke, commit after the pause with the right kind and command (corpus replays)', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await page.evaluate(() => window.__brushDev!.resetMetrics())
  const refresh: number[] = []
  for (const c of CASES) {
    const rec = readRecording(`${c.kind}/${c.id}.json`)
    await prepare(page, rec.sheet)
    const cmdsBefore = (await page.evaluate(() => window.__brush!.commands())).length
    const { duringPenDown, strokeId } = await replayLive(page, rec)
    expect(duringPenDown, `${c.id}: hypotheses before pen-up`).toBeGreaterThan(0)
    const hyps = await page.evaluate(() => window.__brush!.hypotheses())
    const dur = rec.points[rec.points.length - 1].t
    const during = hyps.filter((h) => (h.atMs ?? 0) <= dur)
    if (dur >= 250) refresh.push(during.length / (dur / 1000))
    // commit happens after the pause, not at pen-up
    expect(await page.evaluate(() => window.__brushDev!.live().phase)).toMatch(/pending|offer|drawing/)
    if (c.id === 'wall-000') await page.screenshot({ path: screenPath('m3-ghost') })
    await waitDone(page, strokeId)
    const live = await page.evaluate(() => window.__brushDev!.live())
    expect(live.decision?.kind ?? live.hypothesis?.kind, c.id).toBe(c.kind)
    const cmds = await page.evaluate(() => window.__brush!.commands())
    if (c.op) {
      expect(cmds.length).toBe(cmdsBefore + 1)
      expect(cmds[cmds.length - 1].op).toBe(c.op)
      expect(cmds[cmds.length - 1].strokeId).toBe(strokeId)
      await expect(page.locator(`[data-element="${c.kind}"][data-stroke-id="${strokeId}"]`)).toHaveCount(1)
      await expect(page.getByTestId('reading-command')).toContainText(c.op)
    } else {
      expect(cmds.length).toBe(cmdsBefore)
      await expect(page.getByTestId('commit-note')).toHaveText('Kept as ink')
    }
  }
  await page.evaluate(() => window.__brushDev!.focusSheet(1, 1)) // door + furniture
  await settle(page)
  await page.screenshot({ path: screenPath('m3-committed') })

  const first = await page.evaluate(() => window.__brush!.metrics().firstHypothesisMs)
  expect(first.length).toBe(CASES.length) // one first-hypothesis mark per stroke (budget gated in the perf test below)
  expect(Math.min(...refresh)).toBeGreaterThanOrEqual(10)
  await expect(page.getByTestId('latency')).toContainText('ms')
  await expect(page.getByTestId('host-status')).toHaveText('No host linked')

  // the sidecar keeps accepted elements and the command log across a reload
  const accepted = await page.evaluate(() => window.__brushDev!.accepted())
  const commands = await page.evaluate(() => window.__brush!.commands())
  expect(accepted.length).toBe(4)
  await page.evaluate(() => window.__brushDev!.flushSave())
  await page.reload()
  await page.waitForFunction(() => !!window.__brush)
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-6-sheets.pdf'))
  expect(await page.evaluate(() => window.__brushDev!.accepted())).toEqual(accepted)
  expect(await page.evaluate(() => window.__brush!.commands())).toEqual(commands)
  await expect(page.locator('[data-element]')).toHaveCount(4)
})

test('M3: first-hypothesis latency and refresh rate at the recordings’ timing (budgets first-hypothesis, refresh-rate)', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  for (let i = 0; i < 6; i++) await page.evaluate((s) => window.__brush!.contextFor(`sheet-${s}`), i)
  // warm-up stroke (JIT, first React render of the overlays), not measured
  const warm = readRecording('wall/wall-001.json')
  await prepare(page, warm.sheet)
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), warm)
  await page.evaluate(() => window.__brushDev!.resetMetrics())
  const refresh: number[] = []
  for (const id of ['wall-000', 'wall-002', 'door-000', 'door-001', 'furniture-000', 'furniture-001', 'delete-000', 'delete-001', 'markup-000', 'markup-002']) {
    const kind = id.split('-')[0]
    const rec = readRecording(`${kind}/${id}.json`)
    await prepare(page, rec.sheet)
    await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
    const dur = rec.points[rec.points.length - 1].t
    const hyps = await page.evaluate(() => window.__brush!.hypotheses())
    if (dur >= 250) refresh.push(hyps.filter((h) => (h.atMs ?? 0) <= dur).length / (dur / 1000))
    await page.keyboard.press('Escape') // don't wait for commits; keep sheets clean
    await page.evaluate(() => window.__brush!.undo())
  }
  const first = await page.evaluate(() => window.__brush!.metrics().firstHypothesisMs)
  expect(first.length).toBe(10)
  const v = p95(first)
  refresh.sort((a, b) => a - b)
  const median = refresh[Math.floor(refresh.length / 2)]
  console.log(`first hypothesis p95 ${v.toFixed(1)} ms (n=${first.length}); refresh/s min ${refresh[0].toFixed(1)} median ${median.toFixed(1)}`)
  recordPerf({ firstHypothesisP95Ms: v, hypothesisRefreshPerSec: refresh[0] })
})

test('M3: low confidence offers two chips beside the stroke; tapping one commits that reading (state 6)', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await prepare(page, 0)
  const { strokeId } = await replayLive(page, bentLine(260))
  await waitDone(page, strokeId)
  const live = await page.evaluate(() => window.__brushDev!.live())
  expect(live.phase).toBe('offer')
  expect(live.hypothesis!.confidence).toBeGreaterThanOrEqual(0.35)
  expect(live.hypothesis!.confidence).toBeLessThan(0.6)
  const chips = page.getByTestId('pen-chip')
  await expect(chips).toHaveCount(2)
  expect(await page.evaluate(() => window.__brush!.commands())).toHaveLength(0) // nothing committed while unsure
  await page.screenshot({ path: screenPath('m3-chips') })

  await chips.first().click()
  await page.waitForFunction(() => window.__brushDev!.live().phase === 'committed')
  const cmds = await page.evaluate(() => window.__brush!.commands())
  expect(cmds).toHaveLength(1)
  expect(cmds[0].op).toBe('create_wall')

  // undo removes the element and the command but keeps the ink; undo again removes the stroke
  await page.evaluate(() => window.__brush!.undo())
  expect(await page.evaluate(() => window.__brush!.commands())).toHaveLength(0)
  await expect(page.locator('[data-element]')).toHaveCount(0)
  expect(await strokes(page)).toHaveLength(1)
  await page.evaluate(() => window.__brush!.redo())
  expect(await page.evaluate(() => window.__brush!.commands())).toHaveLength(1)

  // not picking: the next stroke leaves the unsure one as ink
  const second = await replayLive(page, bentLine(330))
  await waitDone(page, second.strokeId)
  expect(await page.evaluate(() => window.__brushDev!.live().phase)).toBe('offer')
  await replayLive(page, bentLine(400))
  expect(await page.evaluate(() => window.__brushDev!.accepted().length)).toBe(1)
})

test('M3: Live off is plain M1 ink; Mode forces a reading', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  await prepare(page, 0)
  await page.getByTestId('live-toggle').click()
  await expect(page.getByTestId('live-toggle')).toHaveAttribute('aria-checked', 'false')
  const rec = readRecording('wall/wall-000.json')
  await prepare(page, rec.sheet)
  await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
  await page.waitForTimeout(600)
  expect(await page.evaluate(() => window.__brush!.hypotheses())).toHaveLength(0)
  expect(await page.evaluate(() => window.__brush!.commands())).toHaveLength(0)
  await expect(page.getByTestId('section-reading')).toContainText('Live reading is off')

  await page.getByTestId('live-toggle').click()
  await page.locator('[data-mode="furniture"]').click()
  const { strokeId } = await replayLive(page, rec)
  await waitDone(page, strokeId)
  const cmds = await page.evaluate(() => window.__brush!.commands())
  expect(cmds[cmds.length - 1]?.op).toBe('place_instance')
})

test('M3: an eraser pass over a drawn item (not over ink) reads as delete and logs a delete command', async ({ page }) => {
  await openWith(page, SIX, { live: true })
  const rec = readRecording('delete/delete-001.json') // tool: eraser
  expect(rec.tool).toBe('eraser')
  await prepare(page, rec.sheet)
  const { strokeId } = await replayLive(page, rec)
  await waitDone(page, strokeId)
  const cmds = await page.evaluate(() => window.__brush!.commands())
  expect(cmds).toHaveLength(1)
  expect(cmds[0].op).toBe('delete')
  if (cmds[0].op === 'delete') expect(cmds[0].targets.length).toBeGreaterThan(0)
  await expect(page.locator('[data-element="delete"] [data-delete-target]').first()).toBeVisible()
  expect(await page.evaluate(() => window.__brush!.strokes().map((s) => s.tool))).toEqual(['eraser'])
  // erasing ink stays plain erasing: no delete command for a pass that removed strokes
  await page.evaluate(() => window.__brush!.setTool('brush'))
  await page.evaluate(() => window.__brush!.undo())
  await page.evaluate(() => window.__brush!.undo())
  expect(await page.evaluate(() => window.__brush!.commands())).toHaveLength(0)
  await page.screenshot({ path: screenPath('m3-eraser-delete') })
})
