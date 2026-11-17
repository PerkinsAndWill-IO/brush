/**
 * M1 "Sketch on PDF" acceptance tests (docs/tasks/M1-sketch-on-pdf.md).
 * Each test cites its requirement ID and saves reports/screens/m1-XX-*.png.
 */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { openApp, screenPath, openPanel } from './helpers'
import { boardCenter, camera, fixturePath, inkCount, line, openWith, openAppMenu, readRecording, replay, sampleInk, settle, strokes } from './m1-helpers'

const SIX = 'office-6-sheets.pdf'

test('M1-01: empty state shows a drop zone and a Choose file button, tools disabled', async ({ page }) => {
  await openApp(page)
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Drop a PDF.* or \.drawing to start/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose file' })).toBeEnabled()
  const tools = page.getByTestId('tool-capsule').getByRole('button')
  expect(await tools.count()).toBeGreaterThanOrEqual(5)
  for (const b of await tools.all()) await expect(b).toBeDisabled()
  // nothing from later milestones
  await expect(page.getByText(/linked|First guess|Live/)).toHaveCount(0)
  await page.screenshot({ path: screenPath('m1-01-empty') })
})

async function dropFile(page: Page, url: string, name: string, type: string) {
  const dt = await page.evaluateHandle(
    async ([u, n, t]) => {
      const bytes = await (await fetch(u)).arrayBuffer()
      const d = new DataTransfer()
      d.items.add(new File([bytes], n, { type: t }))
      return d
    },
    [url, name, type] as const,
  )
  await page.dispatchEvent('.app', 'dragover', { dataTransfer: dt })
  await page.dispatchEvent('.app', 'drop', { dataTransfer: dt })
}

test('M1-02: choosing a PDF opens it; a corrupt PDF or a non-PDF shows an inline error and keeps the empty state', async ({ page }) => {
  await openApp(page)

  // non-PDF, dropped
  await dropFile(page, '/fixtures/pdfs/not-a-pdf.txt', 'not-a-pdf.txt', 'text/plain')
  await expect(page.getByTestId('load-error')).toContainText('not a PDF')
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await page.screenshot({ path: screenPath('m1-02-error-not-pdf') })

  // corrupt PDF, chosen with the file dialog
  let chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(fixturePath('pdfs/corrupt.pdf'))
  await expect(page.getByTestId('load-error')).toContainText('corrupt.pdf')
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await expect(page.getByTestId('board')).toHaveCount(0)
  await page.screenshot({ path: screenPath('m1-02-error-corrupt') })

  // good PDF, chosen
  chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose file' }).click()
  await (await chooser).setFiles(fixturePath('pdfs/office-1-sheet.pdf'))
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(1)
  await expect(page.getByTestId('empty-state')).toHaveCount(0)
  await expect(page.getByTestId('load-error')).toHaveCount(0)

  // good PDF, dropped onto the open board replaces it
  await dropFile(page, `/fixtures/pdfs/${SIX}`, SIX, 'application/pdf')
  await expect(page.locator('[data-testid="sheet"][data-rendered="true"]')).toHaveCount(6)
  await page.screenshot({ path: screenPath('m1-02-opened') })
})

test('M1-03: every page becomes a sheet on one board, in a grid, with its name above it', async ({ page }) => {
  await openWith(page, SIX)
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  expect(sheets).toHaveLength(6)
  await expect(page.getByTestId('sheet')).toHaveCount(6)
  await expect(page.getByTestId('sheet-count')).toHaveText('6 sheets')
  const boxes = []
  for (const [i, s] of sheets.entries()) {
    const el = page.locator(`[data-testid="sheet"][data-sheet-id="${s.id}"]`)
    const label = el.getByTestId('sheet-label')
    await expect(label).toContainText(s.number ?? s.name)
    const lb = (await label.boundingBox())!
    const sb = (await el.locator('.paper').boundingBox())!
    expect(lb.y + lb.height, `label ${i} sits above its sheet`).toBeLessThanOrEqual(sb.y + 1)
    expect(Math.abs(lb.x - sb.x)).toBeLessThan(2)
    boxes.push(sb)
  }
  // 3 × 2 grid in page order
  expect(Math.abs(boxes[0].y - boxes[2].y)).toBeLessThan(1)
  expect(boxes[3].y).toBeGreaterThan(boxes[0].y + boxes[0].height)
  expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width)
  expect(Math.abs(boxes[3].x - boxes[0].x)).toBeLessThan(1)
  // every sheet visible after open (fit all)
  const vp = (await page.getByTestId('board').boundingBox())!
  for (const b of boxes) {
    expect(b.x).toBeGreaterThanOrEqual(vp.x)
    expect(b.x + b.width).toBeLessThanOrEqual(vp.x + vp.width)
  }
  await page.screenshot({ path: screenPath('m1-03-six-sheets') })
})

test('M1-03: loading shows placeholders at the final sheet positions, then fills them in', async ({ page }) => {
  await openApp(page)
  // Start the load without waiting for paint and sample the DOM as soon as sheets exist.
  await page.evaluate(() => void window.__brush!.loadPdf('/fixtures/pdfs/office-6-sheets.pdf'))
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet"]').length === 6)
  const early = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="sheet"]')].map((e) => ({ id: e.dataset.sheetId, left: e.style.left, top: e.style.top, rendered: e.dataset.rendered })),
  )
  expect(early.some((e) => e.rendered === 'false')).toBe(true)
  await page.screenshot({ path: screenPath('m1-03-loading') })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet"][data-rendered="true"]').length === 6)
  const late = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="sheet"]')].map((e) => ({ id: e.dataset.sheetId, left: e.style.left, top: e.style.top })),
  )
  expect(late).toEqual(early.map(({ id, left, top }) => ({ id, left, top })))
})

test('M1-04: pan with the Pan tool, space-drag and two-finger scroll; zoom with Ctrl-scroll and pinch, centered on the pointer', async ({ page }) => {
  await openWith(page, SIX)
  const { x, y } = await boardCenter(page)

  // Pan tool
  await page.evaluate(() => window.__brush!.setTool('pan'))
  let c0 = await camera(page)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 120, y + 60, { steps: 6 })
  await page.mouse.up()
  let c1 = await camera(page)
  expect((c1.x - c0.x) * c0.z).toBeCloseTo(120, 0)
  expect((c1.y - c0.y) * c0.z).toBeCloseTo(60, 0)

  // Space-drag while the brush is active draws nothing
  await page.evaluate(() => window.__brush!.setTool('brush'))
  c0 = c1
  await page.keyboard.down('Space')
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 80, y - 40, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  c1 = await camera(page)
  expect((c1.x - c0.x) * c0.z).toBeCloseTo(-80, 0)
  expect(await strokes(page)).toHaveLength(0)

  // Two-finger scroll (wheel without Ctrl) pans
  c0 = c1
  await page.mouse.move(x, y)
  await page.mouse.wheel(30, 50)
  await page.waitForFunction((cy) => window.__brush!.camera().y !== cy, c0.y)
  c1 = await camera(page)
  expect((c1.y - c0.y) * c0.z).toBeCloseTo(-50, 0)
  expect((c1.x - c0.x) * c0.z).toBeCloseTo(-30, 0)
  expect(c1.z).toBe(c0.z)

  // Ctrl-scroll zooms in around the pointer: the board point under the pointer stays put
  const px = Math.round(x + 150)
  const py = Math.round(y - 70)
  const vp = (await boardCenter(page)).box
  const local = { x: px - vp.x, y: py - vp.y }
  c0 = c1
  await page.mouse.move(px, py)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await page.waitForFunction((z) => window.__brush!.camera().z !== z, c0.z)
  c1 = await camera(page)
  expect(c1.z).toBeGreaterThan(c0.z)
  const before = { x: local.x / c0.z - c0.x, y: local.y / c0.z - c0.y }
  const after = { x: local.x / c1.z - c1.x, y: local.y / c1.z - c1.y }
  expect(after.x).toBeCloseTo(before.x, 3)
  expect(after.y).toBeCloseTo(before.y, 3)

  // Pinch: two touch pointers moving apart zoom in around their midpoint
  c0 = c1
  const mid = { x: vp.x + 400, y: vp.y + 300 }
  await page.evaluate(
    async ({ mid }) => {
      const vpEl = document.querySelector('[data-testid="board"]')!
      const fire = (type: string, id: number, x: number, y: number) =>
        vpEl.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 1, buttons: type === 'pointerup' ? 0 : 1 }))
      fire('pointerdown', 1, mid.x - 50, mid.y)
      fire('pointerdown', 2, mid.x + 50, mid.y)
      for (let i = 1; i <= 10; i++) {
        fire('pointermove', 1, mid.x - 50 - i * 5, mid.y)
        fire('pointermove', 2, mid.x + 50 + i * 5, mid.y)
        await new Promise((r) => requestAnimationFrame(r))
      }
      fire('pointerup', 1, mid.x - 100, mid.y)
      fire('pointerup', 2, mid.x + 100, mid.y)
    },
    { mid },
  )
  c1 = await camera(page)
  expect(c1.z / c0.z).toBeCloseTo(2, 2)
  const m = { x: mid.x - vp.x, y: mid.y - vp.y }
  expect(m.x / c1.z - c1.x).toBeCloseTo(m.x / c0.z - c0.x, 2)
  expect(await strokes(page)).toHaveLength(0)
  await settle(page)
  await expect(page.getByTestId('zoom-button')).toContainText(`${Math.round(c1.z * 100)}%`)
  await page.screenshot({ path: screenPath('m1-04-pan-zoom') })
})

test('M1-05: sheets stay sharp when zoomed — pages re-render at the new resolution after zoom settles (50% vs 400%)', async ({ page }) => {
  await openWith(page, SIX)
  const sheet = page.locator('[data-testid="sheet"][data-sheet-id="sheet-1"]')
  const dpr = await page.evaluate(() => window.devicePixelRatio)

  const zoomTo = async (z: number) => {
    await page.getByTestId('zoom-button').click()
    await page.getByRole('menuitem', { name: `${z * 100}%`, exact: true }).click()
    await expect(sheet).toHaveAttribute('data-render-scale', String(Math.max(0.5, z * dpr)))
    await settle(page)
  }
  const canvasInfo = () =>
    sheet.evaluate((el) => {
      const c = el.querySelector<HTMLCanvasElement>('.page canvas')!
      const r = c.getBoundingClientRect()
      return { w: c.width, h: c.height, cssW: r.width }
    })

  await page.evaluate(() => window.__brushDev!.focusSheet(1, 0.5))
  await zoomTo(0.5)
  const at50 = await canvasInfo()
  expect(at50.w / at50.cssW).toBeGreaterThanOrEqual(dpr * 0.99) // ≥ 1 device pixel per screen pixel
  await page.screenshot({ path: screenPath('m1-05-zoom-50') })

  await zoomTo(4)
  const at400 = await canvasInfo()
  expect(at400.w / at400.cssW).toBeGreaterThanOrEqual(dpr * 0.99)
  expect(at400.w).toBeGreaterThanOrEqual(at50.w * 7.9)

  // Pixel check on the screen itself: at 400% thin PDF lines are crisp (mostly black or white, few grays).
  const shot = await page.screenshot({ path: screenPath('m1-05-zoom-400') })
  const gray = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const vp = document.querySelector('[data-testid="board"]')!.getBoundingClientRect()
    const d = g.getImageData(vp.left + 40, vp.top + 40, vp.width - 80, vp.height - 160).data
    let ink = 0
    let mid = 0
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] + d[i + 1] + d[i + 2]) / 3
      if (v < 90) ink++
      else if (v < 200) mid++
    }
    return { ink, mid }
  }, shot.toString('base64'))
  expect(gray.ink).toBeGreaterThan(200)
  expect(gray.mid / (gray.ink + gray.mid)).toBeLessThan(0.6)
})

test('M1-06: the brush draws ink that follows the pointer, with size and smoothing from the left sidebar, color from the capsule, pressure → width', async ({ page }) => {
  await openWith(page, SIX)
  const rec = readRecording('wall/wall-000.json') // has pressure
  await page.evaluate((i) => window.__brushDev!.focusSheet(i, 1.2), rec.sheet)
  await settle(page)

  // size + smoothing from the left sidebar, color from the capsule
  await openPanel(page, 'tool')
  await page.locator('#brush-size').fill('6')
  await page.locator('#brush-smoothing').fill('60')
  await expect(page.getByTestId('left-sidebar')).toContainText('6 px')
  await page.getByTestId('ink-color').click()
  await page.getByRole('radio', { name: 'blue' }).click()
  await expect(page.getByTestId('ink-color')).toHaveAttribute('aria-label', 'Ink colour, blue')

  // replay at recorded timing and screenshot mid-stroke
  await page.evaluate((r) => {
    ;(window as unknown as { __replay: Promise<void> }).__replay = window.__brush!.replayStroke(r, { realtime: true })
  }, rec)
  await page.waitForFunction(() => (document.querySelector('[data-layer="wet"]:not([d=""])[d]') as SVGPathElement | null)?.getAttribute('d')?.length ?? 0 > 0)
  await page.waitForTimeout(rec.points[rec.points.length - 1].t / 2)
  await page.screenshot({ path: screenPath('m1-06-mid-stroke') })
  await page.evaluate(() => (window as unknown as { __replay: Promise<void> }).__replay)

  const [s] = await strokes(page)
  expect(s.size).toBe(6)
  expect(s.color?.toLowerCase()).toBe('#1e55d9')
  expect(s.tool).toBe('brush')
  expect(s.points.length).toBe(rec.points.length)
  expect(s.points.every((p) => typeof p.p === 'number')).toBe(true)
  // the committed ink follows the pointer: blue ink under every recorded point (smoothing may shift it slightly)
  expect(await inkCount(page)).toBe(1)
  const samples = await sampleInk(page, s.sheetId, rec.points)
  const onInk = samples.filter((x) => x.rgba[3] > 127 && x.rgba[2] > 150 && x.rgba[0] < 80).length
  expect(onInk / samples.length).toBeGreaterThan(0.85)
  // pressure varies width: thicker where the pen pressed harder
  const byP = rec.points.map((p, i) => ({ p: p.p!, w: samples[i].thickness })).filter((x) => x.w > 0)
  const lo = byP.reduce((a, b) => (b.p < a.p ? b : a))
  const hi = byP.reduce((a, b) => (b.p > a.p ? b : a))
  expect(hi.w).toBeGreaterThan(lo.w * 1.5)

  // without pressure: constant width = brush size
  const plain = line(SIX, rec.sheet, [300, 300], [600, 300])
  await replay(page, plain)
  const all = await strokes(page)
  expect(all).toHaveLength(2)
  expect(all[1].points.some((p) => p.p !== undefined)).toBe(false)
  const widths = (await sampleInk(page, all[1].sheetId, [{ x: 400, y: 300 }, { x: 450, y: 300 }, { x: 500, y: 300 }])).map((x) => x.thickness)
  for (const w of widths) expect(w).toBeGreaterThan(5)
  for (const w of widths) expect(w).toBeLessThan(7.5)
  const lat = await page.evaluate(() => window.__brush!.metrics().inkLatencyMs)
  expect(lat.length).toBeGreaterThan(rec.points.length)
  await page.screenshot({ path: screenPath('m1-06-ink') })
})

test('M1-07: a stroke belongs to the sheet it started on, stored in that sheet’s PDF points; ink outside any sheet is discarded', async ({ page }) => {
  await openWith(page, SIX)
  const rec = readRecording('wall/wall-001.json')
  await replay(page, rec)
  let all = await strokes(page)
  expect(all).toHaveLength(1)
  expect(all[0].sheetId).toBe(`sheet-${rec.sheet}`)
  all[0].points.forEach((p, i) => {
    expect(p.x).toBeCloseTo(rec.points[i].x, 2)
    expect(p.y).toBeCloseTo(rec.points[i].y, 2)
  })
  expect(all[0].points[0].t).toBe(0)

  // same gesture at another zoom → same sheet points (survives zoom)
  await page.evaluate((i) => window.__brushDev!.focusSheet(i, 3), rec.sheet)
  await settle(page)
  await page.evaluate(() => window.__brush!.undo())
  await replay(page, rec)
  all = await strokes(page)
  expect(all).toHaveLength(1)
  all[0].points.forEach((p, i) => expect(Math.hypot(p.x - rec.points[i].x, p.y - rec.points[i].y)).toBeLessThan(0.02))

  // a stroke that starts on sheet 0 and runs onto sheet 1 belongs to sheet 0 (x beyond its width)
  await page.evaluate(() => window.__brushDev!.fit())
  await settle(page)
  const sheets = await page.evaluate(() => window.__brush!.sheets())
  const w0 = sheets[0].sizePt.w
  await replay(page, line(SIX, 0, [w0 - 100, 400], [w0 + 400, 400], 30))
  all = await strokes(page)
  expect(all).toHaveLength(2)
  expect(all[1].sheetId).toBe('sheet-0')
  expect(Math.max(...all[1].points.map((p) => p.x))).toBeGreaterThan(w0 + 300)

  // a stroke that starts between sheets is discarded
  await replay(page, line(SIX, 0, [w0 + 40, 400], [w0 + 60, 500]))
  await replay(page, line(SIX, 0, [-60, -60], [200, 200]))
  expect(await strokes(page)).toHaveLength(2)
  await page.screenshot({ path: screenPath('m1-07-sheet-coords') })
})

test('M1-08: the eraser removes whole strokes it touches', async ({ page }) => {
  await openWith(page, SIX)
  await page.evaluate(() => window.__brushDev!.focusSheet(2, 1))
  await settle(page)
  await replay(page, line(SIX, 2, [200, 200], [700, 200]))
  await replay(page, line(SIX, 2, [200, 300], [700, 320]))
  await replay(page, line(SIX, 2, [200, 600], [700, 600]))
  expect(await strokes(page)).toHaveLength(3)
  await page.screenshot({ path: screenPath('m1-08-before-erase') })

  // erase path crosses the first two strokes only, near their middle
  await replay(page, line(SIX, 2, [450, 150], [460, 400], 20, { tool: 'eraser' }))
  const left = await strokes(page)
  expect(left).toHaveLength(1)
  expect(left[0].points[0].y).toBeCloseTo(600, 1)
  expect(left[0].points).toHaveLength(24) // whole stroke kept, never split
  expect(await inkCount(page)).toBe(1)
  // the eraser itself leaves no ink and the active tool is restored
  await expect(page.locator('[data-tool="brush"]')).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: screenPath('m1-08-after-erase') })
})

test('M1-09: undo and redo cover strokes and erasures, from the top bar and Ctrl-Z / Ctrl-Shift-Z', async ({ page }) => {
  await openWith(page, SIX)
  await page.evaluate(() => window.__brushDev!.focusSheet(0, 1))
  await settle(page)
  const count = async () => (await strokes(page)).length
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  await replay(page, line(SIX, 0, [200, 200], [600, 200]))
  await replay(page, line(SIX, 0, [200, 400], [600, 400]))
  expect(await count()).toBe(2)

  await page.getByRole('button', { name: 'Undo' }).click()
  expect(await count()).toBe(1)
  await page.locator('body').click({ position: { x: 5, y: 5 } }) // focus the page, not a button
  await page.keyboard.press('Control+z')
  expect(await count()).toBe(0)
  await page.keyboard.press('Control+Shift+z')
  expect(await count()).toBe(1)
  await page.getByRole('button', { name: 'Redo' }).click()
  expect(await count()).toBe(2)
  await expect(page.getByRole('button', { name: 'Redo' })).toBeDisabled()

  // erasure is undoable too, and the stroke comes back in place
  const before = await strokes(page)
  await replay(page, line(SIX, 0, [400, 150], [400, 250], 12, { tool: 'eraser' }))
  expect(await count()).toBe(1)
  await page.keyboard.press('Control+z')
  expect(await strokes(page)).toEqual(before)
  await page.keyboard.press('Control+Shift+z')
  expect(await count()).toBe(1)
  await page.getByRole('button', { name: 'Undo' }).click()
  expect(await count()).toBe(2)
  await page.screenshot({ path: screenPath('m1-09-undo-redo') })
})

test('M1-10: work autosaves to the sidecar and is restored when the same PDF is reopened', async ({ page }) => {
  await openWith(page, SIX)
  await replay(page, readRecording('wall/wall-000.json'))
  await replay(page, line(SIX, 1, [100, 100], [500, 300]))
  const drawn = await strokes(page)
  expect(drawn).toHaveLength(2)
  await page.evaluate(() => window.__brushDev!.flushSave())
  await expect(page.getByTestId('save-state')).toHaveText('Saved')

  // the sidecar is a SessionFile keyed by PDF name + size
  const file = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('brush')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const keys = await new Promise<IDBValidKey[]>((res) => {
      const r = db.transaction('sidecars').objectStore('sidecars').getAllKeys()
      r.onsuccess = () => res(r.result)
    })
    const val = await new Promise<string>((res) => {
      const r = db.transaction('sidecars').objectStore('sidecars').get(keys[0])
      r.onsuccess = () => res(r.result as string)
    })
    return { keys, session: JSON.parse(val) }
  })
  expect(String(file.keys[0])).toMatch(/^brush\.sidecar:office-6-sheets\.pdf:\d+$/)
  expect(file.session.schemaVersion).toBe(1)
  expect(file.session.pdf.name).toBe(SIX)
  expect(file.session.strokes).toEqual(drawn)

  // reload the app and reopen the same PDF
  await page.reload()
  await page.waitForFunction(() => !!window.__brush)
  await expect(page.getByTestId('empty-state')).toBeVisible()
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-6-sheets.pdf'))
  expect(await strokes(page)).toEqual(drawn)
  expect(await inkCount(page)).toBe(2)

  // a different PDF starts clean; going back restores again
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-1-sheet.pdf'))
  expect(await strokes(page)).toHaveLength(0)
  await page.evaluate(() => window.__brush!.loadPdf('/fixtures/pdfs/office-6-sheets.pdf'))
  expect(await strokes(page)).toEqual(drawn)
  await page.screenshot({ path: screenPath('m1-10-restored') })
})

test('M1-11: left sidebar shows the active tool’s options; sections collapse; Mode, Snapping, Commit present (enabled from M2/M3; Mode off with Live off)', async ({ page }) => {
  await openWith(page, SIX)
  const side = page.getByTestId('left-sidebar')
  // the sidebars are collapsed to icon rails: open the tool's options
  await expect(side).toHaveCount(0)
  await openPanel(page, 'tool')
  await expect(side.locator('.tool-name')).toHaveText('Brush')
  await expect(side.locator('#brush-size')).toBeEnabled()
  await expect(side.locator('#brush-smoothing')).toBeEnabled()
  for (const id of ['section-mode', 'section-snapping', 'section-commit']) {
    const sec = side.getByTestId(id)
    await expect(sec).toBeVisible()
    if ((await sec.getAttribute('data-open')) === 'false') await sec.getByRole('button').first().click()
    expect(await sec.locator('.section-body button, .section-body input').count()).toBeGreaterThan(0)
  }
  // Live off is the plain M1 surface: Mode is disabled and labeled, the Reading panel says so
  await expect(side.getByTestId('section-mode')).toContainText('Live off')
  for (const c of await side.locator('[data-testid="section-mode"] .section-body button').all()) await expect(c).toBeDisabled()
  await openPanel(page, 'reading')
  await expect(page.getByTestId('section-reading')).toContainText('Live reading is off')
  await openPanel(page, 'session')
  await expect(page.getByTestId('right-sidebar')).toContainText('This session')
  // turning Live on enables Mode (M3)
  await page.getByTestId('live-toggle').click()
  await expect(side.locator('[data-mode="wall"]')).toBeEnabled()
  await page.getByTestId('live-toggle').click()
  await page.screenshot({ path: screenPath('m1-11-sidebar-open') })

  // collapse Stroke
  const stroke = side.getByTestId('section-stroke')
  await stroke.getByRole('button', { name: /Stroke/ }).click()
  await expect(stroke.getByRole('button', { name: /Stroke/ })).toHaveAttribute('aria-expanded', 'false')
  await expect(side.locator('#brush-size')).toHaveCount(0)
  await stroke.getByRole('button', { name: /Stroke/ }).click()
  await expect(side.locator('#brush-size')).toBeVisible()

  // options follow the active tool
  await page.getByRole('button', { name: 'Eraser' }).click()
  await expect(side.locator('.tool-name')).toHaveText('Eraser')
  await expect(side.locator('#eraser-size')).toBeVisible()
  await expect(side.locator('#brush-size')).toHaveCount(0)
  await page.screenshot({ path: screenPath('m1-11-sidebar-eraser') })
})

test('M1-12: strokes can be recorded to fixture files from a dev-only toggle (write + re-read a StrokeRecording)', async ({ page }) => {
  await openWith(page, SIX)
  await page.evaluate(() => window.__brushDev!.focusSheet(4, 1))
  await settle(page)
  await openAppMenu(page)
  await page.getByTestId('record-toggle').click()
  await expect(page.getByTestId('record-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('record-kind').selectOption('door')

  const src = line(SIX, 4, [300, 300], [340, 360], 16, { label: { kind: 'markup' } })
  src.points = src.points.map((p, i) => ({ ...p, p: 0.3 + i * 0.02 }))
  await replay(page, src, true)
  const [drawn] = await strokes(page)
  await openPanel(page, 'recordings')
  await expect(page.getByTestId('recordings-list').locator('li')).toHaveCount(1)
  await page.screenshot({ path: screenPath('m1-12-recording') })

  // write: Save downloads <kind>-*.json
  const download = page.waitForEvent('download')
  await page.getByTestId('save-recording').click()
  const dl = await download
  expect(dl.suggestedFilename()).toMatch(/^door-.*\.json$/)
  const path = await dl.path()
  const rec = JSON.parse(readFileSync(path, 'utf8'))

  // re-read: it is a valid StrokeRecording with the label, sheet and raw points
  expect(await page.evaluate((r) => window.__brushDev!.isStrokeRecording(r), rec)).toBe(true)
  expect(rec.pdf).toBe(SIX)
  expect(rec.sheet).toBe(4)
  expect(rec.label.kind).toBe('door')
  expect(rec.tool).toBe('brush')
  expect(rec.points).toEqual(drawn.points)

  // and it replays to the same stroke
  await openAppMenu(page)
  await page.getByTestId('record-toggle').click()
  await replay(page, rec)
  const all = await strokes(page)
  expect(all).toHaveLength(2)
  all[1].points.forEach((p, i) => expect(Math.hypot(p.x - rec.points[i].x, p.y - rec.points[i].y)).toBeLessThan(0.02))
  await expect(page.getByTestId('save-recording')).toHaveText('Saved')
})
