/**
 * M1 budgets (scripts/budgets.ts): ink latency p95 and pan/zoom frame rate.
 * Both are measured inside the app (src/app/metrics.ts) on the real code path
 * and written to reports/perf.json with recordPerf.
 */
import { readdirSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Stroke, StrokeRecording } from '../../src/core/types'
import { p95, recordPerf, screenPath } from './helpers'
import { fixturePath, inkCount, openWith, readRecording, settle } from './m1-helpers'

test('M1-06 perf: ink latency, pointer event → painted stroke, p95 (budget inkLatencyP95Ms), with Live reading on', async ({ page }) => {
  await openWith(page, 'office-6-sheets.pdf', { live: true })
  const files = readdirSync(fixturePath('strokes/wall')).filter((f) => f.endsWith('.json')).slice(0, 6)
  const recs: StrokeRecording[] = files.map((f) => readRecording(`wall/${f}`))
  await page.evaluate(() => window.__brushDev!.resetMetrics())
  for (const rec of recs) {
    await page.evaluate((i) => window.__brushDev!.focusSheet(i, 1), rec.sheet)
    await settle(page)
    await page.evaluate((r) => window.__brush!.replayStroke(r, { realtime: true }), rec)
  }
  const lat = await page.evaluate(() => window.__brush!.metrics().inkLatencyMs)
  expect(lat.length).toBeGreaterThan(100)
  const v = p95(lat)
  const sorted = [...lat].sort((a, b) => a - b)
  console.log(`ink latency: n=${lat.length} p50=${sorted[Math.floor(lat.length / 2)].toFixed(2)} p95=${v.toFixed(2)} max=${sorted[sorted.length - 1].toFixed(2)} ms`)
  recordPerf({ inkLatencyP95Ms: v })
  await page.screenshot({ path: screenPath('m1-perf-ink') })
})

test('M1-04 perf: pan and zoom frame rate with 6 sheets and 500 strokes (budget panZoomFps)', async ({ page }) => {
  await openWith(page, 'office-6-sheets.pdf')
  // 500 strokes spread over the six sheets (wavy lines, 40 points each)
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  const strokes: Stroke[] = Array.from({ length: 500 }, (_, k) => {
    const s = sheets[k % 6]
    const x0 = 80 + ((k * 37) % (s.sizePt.w - 400))
    const y0 = 80 + ((k * 53) % (s.sizePt.h - 200))
    return {
      id: `perf-${k}`,
      sheetId: s.id,
      tool: 'brush',
      size: 2 + (k % 4),
      color: '#D7263D',
      points: Array.from({ length: 40 }, (_, i) => ({ x: x0 + i * 7, y: y0 + Math.sin(i / 4 + k) * 25, t: i * 8 })),
    }
  })
  await page.evaluate((s) => window.__brushDev!.addStrokes(s), strokes)
  await expect.poll(() => inkCount(page)).toBe(strokes.length)
  await settle(page)
  await page.evaluate(() => window.__brushDev!.resetMetrics())

  // Scripted gesture: real wheel events on the board, one per frame — pan, then Ctrl-zoom in and out.
  const measured = await page.evaluate(async () => {
    const vp = document.querySelector('[data-testid="board"]')!
    const r = vp.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
    const frame = () => new Promise<number>((res) => requestAnimationFrame(res))
    const times: number[] = []
    for (let i = 0; i < 240; i++) {
      const phase = Math.floor(i / 60)
      const ev =
        phase === 0 || phase === 2
          ? new WheelEvent('wheel', { ...at, deltaX: phase === 0 ? 6 : -6, deltaY: phase === 0 ? 3 : -3, bubbles: true, cancelable: true })
          : new WheelEvent('wheel', { ...at, deltaY: phase === 1 ? -4 : 4, ctrlKey: true, bubbles: true, cancelable: true })
      vp.dispatchEvent(ev)
      times.push(await frame())
    }
    await new Promise((res) => setTimeout(res, 400)) // let the camera settle so the in-app meter records its sample
    const intervals = times.slice(1).map((t, i) => t - times[i])
    return { scriptFps: (intervals.length * 1000) / (times[times.length - 1] - times[0]), worst: Math.max(...intervals), slow: intervals.map((v, i) => [i, Math.round(v)]).filter(([, v]) => v > 20) }
  })
  const appFps = await page.evaluate(() => window.__brush!.metrics().fps)
  expect(appFps.length).toBeGreaterThan(0)
  const fps = Math.min(...appFps)
  console.log(`pan/zoom fps: app meter ${appFps.map((f) => f.toFixed(1)).join(', ')} · script ${measured.scriptFps.toFixed(1)} · worst frame ${measured.worst.toFixed(1)} ms ${JSON.stringify(measured.slow)}`)
  recordPerf({ panZoomFps: fps })
  await page.screenshot({ path: screenPath('m1-perf-500-strokes') })
})
