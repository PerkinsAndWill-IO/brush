// Performance probe for large `.drawing` files in real Chrome (GPU canvas): load to first paint, all sheets painted,
// per-page render cost at several scales, zoom frame times and the re-render after a zoom settles, memory.
// Usage (from editor/, with `vite --port 5310` running): node scripts/perf-drawing.mjs /fixtures/perf/kro-test-lean.drawing ...
// (Git Bash rewrites a leading-slash argument into a Windows path: prefix the command with MSYS_NO_PATHCONV=1.)
// Files are served by the dev server's /fixtures route. Prints one JSON object per file.
import { chromium } from '@playwright/test'

const BASE = process.env.BRUSH_URL ?? 'http://127.0.0.1:5310/'
const files = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-precise-memory-info'] })

for (const file of files) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('requestfailed', (r) => console.error('requestfailed', r.url(), r.failure()?.errorText))
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Performance.enable')
  await page.goto(BASE)
  await page.waitForFunction(() => window.__brush)
  // long tasks and frame intervals, recorded from now on
  await page.evaluate(() => {
    window.__perf = { long: [], frames: [] }
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.long.push([e.startTime, e.duration]))).observe({ type: 'longtask', buffered: false })
    let last = performance.now()
    const tick = (t) => {
      window.__perf.frames.push([t, t - last])
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const out = { file }
  out.load = await page.evaluate(async (url) => {
    const t0 = performance.now()
    await window.__brush.loadPdf(url)
    const tFirst = performance.now() - t0
    // all sheets painted
    await new Promise((res) => {
      const check = () => ([...document.querySelectorAll('[data-testid=sheet]')].every((s) => s.dataset.rendered === 'true') ? res() : setTimeout(check, 20))
      check()
    })
    const tAll = performance.now() - t0
    const long = window.__perf.long.filter(([s]) => s >= t0).map(([, d]) => Math.round(d))
    return { firstPageMs: Math.round(tFirst), allPagesMs: Math.round(tAll), longTasksMs: long }
  }, file)

  // phases in isolation: fetch, gunzip+parse, sheets/analysis, per-page compile+render at several scales (GPU flush by readback)
  out.phases = await page.evaluate(async (url) => {
    const r = {}
    let t = performance.now()
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    r.fetchMs = Math.round(performance.now() - t)
    const { parseDrawingFile } = await import('/src/app/source/drawing-file.ts')
    const { sheetsFromDrawing } = await import('/src/core/context/drawing.ts')
    const { renderDrawingPage } = await import('/src/app/drawing/render.ts')
    const { renderScaleFor } = await import('/src/app/board/layout.ts')
    t = performance.now()
    const doc = await parseDrawingFile(bytes)
    r.parseMs = Math.round(performance.now() - t)
    t = performance.now()
    sheetsFromDrawing(doc)
    r.sheetsMs = Math.round(performance.now() - t)
    r.pages = []
    for (const p of doc.pages) {
      const cap = renderScaleFor(1e6, 1, p.sizePt)
      const row = { id: p.number ?? p.id, items: p.items.length, sizePt: [Math.round(p.sizePt.w), Math.round(p.sizePt.h)], capPxPerPt: +cap.toFixed(2) }
      for (const s of [0.25, 0.5, cap]) {
        const c = document.createElement('canvas')
        t = performance.now()
        await renderDrawingPage(p, c, s)
        const tDraw = performance.now() - t
        c.getContext('2d').getImageData(0, 0, 1, 1) // waits for the GPU raster
        const tFlush = performance.now() - t
        // a sheet that draws only fills, or nothing, is a regression: count non-white pixels in a downscaled copy
        const probe = document.createElement('canvas')
        probe.width = 200
        probe.height = Math.round((200 * c.height) / c.width)
        const pg = probe.getContext('2d')
        pg.drawImage(c, 0, 0, probe.width, probe.height)
        const d = pg.getImageData(0, 0, probe.width, probe.height).data
        let ink = 0
        for (let k = 0; k < d.length; k += 4) if (d[k] < 250 || d[k + 1] < 250 || d[k + 2] < 250) ink++
        row[`s${+s.toFixed(2)}`] = { callMs: Math.round(tDraw), withRasterMs: Math.round(tFlush), inkPct: +((100 * ink) / (d.length / 4)).toFixed(1) }
        c.width = c.height = 0
      }
      r.pages.push(row)
    }
    return r
  }, file)

  // zoom: ctrl+wheel bursts over the board centre, then wait for the settle re-render
  const vp = page.viewportSize()
  await page.mouse.move(vp.width / 2, vp.height / 2)
  out.zoom = []
  for (const [label, dy, n] of [['in x8', -100, 8], ['in x8 more', -100, 8], ['out x16', 100, 16]]) {
    const t0 = await page.evaluate(() => performance.now())
    await page.keyboard.down('Control')
    for (let i = 0; i < n; i++) {
      await page.mouse.wheel(0, dy)
      await page.waitForTimeout(16)
    }
    await page.keyboard.up('Control')
    const tGestureEnd = await page.evaluate(() => performance.now())
    // settled when no render-scale attribute changed for 1.5 s
    const res = await page.evaluate(async ([t0, tEnd]) => {
      const scales = () => [...document.querySelectorAll('[data-testid=sheet]')].map((s) => s.dataset.renderScale).join(',')
      let last = scales()
      let lastChange = performance.now()
      while (performance.now() - lastChange < 1500) {
        await new Promise((r) => setTimeout(r, 30))
        const now = scales()
        if (now !== last) {
          last = now
          lastChange = performance.now()
        }
      }
      const during = window.__perf.frames.filter(([t]) => t >= t0 && t <= tEnd).map(([, d]) => d)
      const after = window.__perf.frames.filter(([t]) => t > tEnd && t <= lastChange + 100).map(([, d]) => d)
      const pct = (a, p) => (a.length ? Math.round([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))]) : null)
      const long = window.__perf.long.filter(([s]) => s >= t0).map(([, d]) => Math.round(d))
      return {
        z: +window.__brush.camera().z.toFixed(3),
        renderScales: last,
        gestureFrames: { n: during.length, p50: pct(during, 0.5), p95: pct(during, 0.95), max: pct(during, 1) },
        settleFrames: { n: after.length, p95: pct(after, 0.95), max: pct(after, 1) },
        rerenderDoneMs: Math.round(lastChange - tEnd),
        longTasksMs: long,
      }
    }, [t0, tGestureEnd])
    out.zoom.push({ step: label, ...res })
  }

  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]))
  out.memory = await page.evaluate(() => ({
    jsHeapMB: Math.round(performance.memory.usedJSHeapSize / 1e6),
    canvasMpx: +([...document.querySelectorAll('canvas')].reduce((s, c) => s + c.width * c.height, 0) / 1e6).toFixed(1),
  }))
  out.memory.cdpHeapMB = Math.round(m.JSHeapUsedSize / 1e6)
  await page.screenshot({ path: `reports/perf-${file.split('/').pop()}.png` })
  console.log(JSON.stringify(out))
  await ctx.close()
}
await browser.close()
