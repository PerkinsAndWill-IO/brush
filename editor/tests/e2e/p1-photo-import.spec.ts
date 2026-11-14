/**
 * P1 photo import (docs/tasks/P1-photo-import.md): a photo of a printed sheet with pen markup on it is traced
 * and added as brush strokes on the right sheet, as one undo step. The "photo" is made in the page: the sheet as
 * the app renders it, on a table, turned and scaled, softened like a lens would, lit unevenly, with two pen
 * strokes at known sheet coordinates.
 */
import { expect, test, type Page } from '@playwright/test'
import type { Stroke } from '../../src/core/types'
import { screenPath } from './helpers'
import { openWith } from './m1-helpers'

const PDF = 'office-6-sheets.pdf'
/** The sheet in the photo (0-based page). */
const PAGE = 2

/** Markup drawn on the photo, in sheet points. */
const RED: [number, number][] = [
  [300, 250],
  [520, 250],
  [520, 400],
]
const BLUE = { cx: 760, cy: 480, rx: 70, ry: 45 }

/** Build the photo in the page and return it as base64 JPEG. `markup: false` leaves the sheet clean. */
async function makePhoto(page: Page, opts: { pageIndex: number; markup: boolean }): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ pageIndex, markup, red, blue }) => {
      // The print, at print resolution. The camera then sees it at about half that: built from a coarse render
      // instead, hairlines would be a full pixel wide, far heavier than on paper, and read as pen.
      const dpi = 150
      const s = dpi / 72
      const sheet = await window.__brushDev!.renderSheet(pageIndex, s)
      // the sheet with the markup on it, at sheet resolution
      const paper = document.createElement('canvas')
      paper.width = sheet.width
      paper.height = sheet.height
      const p = paper.getContext('2d')!
      p.drawImage(sheet, 0, 0)
      // print seen by a camera is dark grey, never black (toner sheen, lens flare)
      p.fillStyle = 'rgba(255,255,255,0.3)'
      p.fillRect(0, 0, paper.width, paper.height)
      if (markup) {
        p.lineCap = 'round'
        p.lineJoin = 'round'
        p.strokeStyle = '#d0202c'
        p.lineWidth = 2.4 * s
        p.beginPath()
        red.forEach(([x, y], i) => (i ? p.lineTo(x * s, y * s) : p.moveTo(x * s, y * s)))
        p.stroke()
        p.strokeStyle = '#1e50c8'
        p.lineWidth = 2.8 * s
        p.beginPath()
        p.ellipse(blue.cx * s, blue.cy * s, blue.rx * s, blue.ry * s, 0, 0, Math.PI * 2)
        p.stroke()
      }
      // the photo: table, the sheet turned a little, lens softness, a light gradient
      const photo = document.createElement('canvas')
      photo.width = 1500
      photo.height = 1100
      const g = photo.getContext('2d')!
      g.fillStyle = '#6b5a48'
      g.fillRect(0, 0, photo.width, photo.height)
      g.filter = 'blur(0.8px)'
      g.imageSmoothingQuality = 'high'
      g.translate(photo.width / 2, photo.height / 2)
      g.rotate(0.05)
      g.scale(0.52, 0.5)
      g.drawImage(paper, -paper.width / 2, -paper.height / 2)
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.filter = 'none'
      const light = g.createLinearGradient(0, 0, photo.width, photo.height)
      light.addColorStop(0, 'rgba(0,0,0,0.02)')
      light.addColorStop(1, 'rgba(0,0,0,0.2)')
      g.fillStyle = light
      g.fillRect(0, 0, photo.width, photo.height)
      const blob = await new Promise<Blob>((r) => photo.toBlob((b) => r(b!), 'image/jpeg', 0.92))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(bin)
    },
    { pageIndex: opts.pageIndex, markup: opts.markup, red: RED, blue: BLUE },
  )
  return Buffer.from(b64, 'base64')
}

const distToSegments = (p: { x: number; y: number }, poly: [number, number][]) => {
  let best = Infinity
  for (let k = 0; k + 1 < poly.length; k++) {
    const [ax, ay] = poly[k]
    const [bx, by] = poly[k + 1]
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy))
  }
  return best
}
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

test.describe('P1 photo import', () => {
  test.setTimeout(240_000)

  test('P1-01..05: Import photo (app menu) finds the sheet, adds the traced pen strokes to it, and undo removes them in one step', async ({ page }) => {
    await openWith(page, PDF)
    const photo = await makePhoto(page, { pageIndex: PAGE, markup: true })

    await page.getByTestId('app-menu-button').click()
    await page.getByTestId('import-photo').click()
    await expect(page.getByTestId('photo-import')).toBeVisible()
    await expect(page.getByTestId('photo-run')).toBeDisabled()
    await page.getByTestId('photo-file').setInputFiles({ name: 'markup.jpg', mimeType: 'image/jpeg', buffer: photo })
    await expect(page.getByTestId('photo-choose')).toHaveText('markup.jpg')
    await page.getByTestId('photo-run').click()
    await expect(page.getByTestId('photo-progress')).toBeVisible()
    await expect(page.getByTestId('photo-import')).toHaveAttribute('data-phase', 'done', { timeout: 200_000 })

    // P1-02: the sheet was found among six look-alike floors
    const sheets = await page.evaluate(() => window.__brush!.sheets())
    await expect(page.getByTestId('photo-summary')).toContainText(`${sheets[PAGE].number} ${sheets[PAGE].name}`)
    await page.screenshot({ path: screenPath('p1-photo-import-summary.png') })
    await page.getByTestId('photo-done').click()
    await expect(page.getByTestId('photo-import')).toHaveCount(0)

    // P1-03, P1-04: the strokes sit on that sheet, where the pen went, in the pen's colour
    const strokes = (await page.evaluate(() => window.__brush!.strokes())) as Stroke[]
    expect(strokes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(strokes.map((s) => s.sheetId))).toEqual(new Set([sheets[PAGE].id]))
    expect(strokes.every((s) => s.tool === 'brush' && s.points.length > 0)).toBe(true)
    const reds = strokes.filter((s) => {
      const [r, g, b] = channels(s.color!)
      return r > 140 && g < 90 && b < 90
    })
    const blues = strokes.filter((s) => {
      const [r, , b] = channels(s.color!)
      return b > 130 && r < 90
    })
    expect(reds.length).toBeGreaterThanOrEqual(1)
    expect(blues.length).toBeGreaterThanOrEqual(1)
    // nothing but the two pens: the drawing itself is not ink
    const others = strokes.filter((s) => !reds.includes(s) && !blues.includes(s))
    const where = (s: Stroke) => {
      const xs = s.points.map((p) => p.x)
      const ys = s.points.map((p) => p.y)
      return `${s.color} w${s.size} x ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)} y ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}`
    }
    expect(others.map(where), 'strokes that are neither pen').toEqual([])
    const redPts = reds.flatMap((s) => s.points)
    expect(redPts.filter((p) => distToSegments(p, RED) < 3).length / redPts.length).toBeGreaterThan(0.95)
    for (const v of RED) expect(Math.min(...redPts.map((p) => Math.hypot(p.x - v[0], p.y - v[1])))).toBeLessThan(6)
    const bluePts = blues.flatMap((s) => s.points)
    const onEllipse = (p: { x: number; y: number }) => Math.abs(Math.hypot((p.x - BLUE.cx) / BLUE.rx, (p.y - BLUE.cy) / BLUE.ry) - 1) < 0.08
    expect(bluePts.filter(onEllipse).length / bluePts.length).toBeGreaterThan(0.95)
    // pen width, in sheet points (drawn 2.4 and 2.8)
    for (const s of strokes) {
      expect(s.size).toBeGreaterThan(1)
      expect(s.size).toBeLessThan(5)
    }
    // the ink is on the board
    await expect(page.locator(`[data-sheet-id="${sheets[PAGE].id}"] .ink path`).first()).toBeAttached()
    await page.screenshot({ path: screenPath('p1-photo-import.png') })

    // P1-05: one undo step
    await page.evaluate(() => window.__brush!.undo())
    expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(0)
    await page.evaluate(() => window.__brush!.redo())
    expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(strokes.length)
  })

  test('P1-06: a photo that shows none of the sheets says so and adds nothing', async ({ page }) => {
    await openWith(page, 'office-1-sheet.pdf')
    // a "photo" of something else: a table with a few boxes on it
    const b64 = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 1200
      c.height = 900
      const g = c.getContext('2d')!
      g.fillStyle = '#6b5a48'
      g.fillRect(0, 0, c.width, c.height)
      for (let i = 0; i < 40; i++) {
        g.fillStyle = `hsl(${(i * 53) % 360} 40% ${30 + ((i * 17) % 50)}%)`
        g.fillRect((i * 197) % 1100, (i * 131) % 800, 40 + ((i * 29) % 120), 30 + ((i * 41) % 90))
      }
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(bin)
    })
    await page.getByTestId('app-menu-button').click()
    await page.getByTestId('import-photo').click()
    await page.getByTestId('photo-file').setInputFiles({ name: 'desk.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') })
    await page.getByTestId('photo-run').click()
    await expect(page.getByTestId('photo-error')).toContainText('does not match any open sheet', { timeout: 120_000 })
    await expect(page.getByTestId('photo-import')).toHaveAttribute('data-phase', 'pick')
    expect(await page.evaluate(() => window.__brush!.strokes().length)).toBe(0)
    await page.screenshot({ path: screenPath('p1-photo-import-refused.png') })
  })

  test('P1-01: a photo dropped on an open drawing opens the import dialog with it; Escape closes', async ({ page }) => {
    await openWith(page, 'office-1-sheet.pdf')
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array([0xff, 0xd8, 0xff])], 'site-photo.jpg', { type: 'image/jpeg' }))
      document.querySelector('.app')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    })
    await expect(page.getByTestId('photo-import')).toBeVisible()
    await expect(page.getByTestId('photo-choose')).toHaveText('site-photo.jpg')
    // the drawing stays open
    expect(await page.evaluate(() => window.__brush!.sheets().length)).toBe(1)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('photo-import')).toHaveCount(0)
  })

  test('P1-01: a sheet chosen for one drawing is not carried to the next one', async ({ page }) => {
    await openWith(page, PDF)
    await page.getByTestId('app-menu-button').click()
    await page.getByTestId('import-photo').click()
    await page.getByTestId('photo-sheet').selectOption('sheet-4')
    await page.keyboard.press('Escape')
    // reopened on the same drawing, the choice is still there
    await page.getByTestId('app-menu-button').click()
    await page.getByTestId('import-photo').click()
    await expect(page.getByTestId('photo-sheet')).toHaveValue('sheet-4')
    await page.keyboard.press('Escape')

    // another drawing, with one sheet: "sheet-4" does not exist there
    await page.evaluate((u) => window.__brush!.loadPdf(u), '/fixtures/pdfs/office-1-sheet.pdf')
    await expect(page.getByTestId('sheet-count')).toHaveText('1 sheet')
    const photo = await makePhoto(page, { pageIndex: 0, markup: true })
    await page.getByTestId('app-menu-button').click()
    await page.getByTestId('import-photo').click()
    await expect(page.getByTestId('photo-sheet')).toHaveValue('')
    await page.getByTestId('photo-file').setInputFiles({ name: 'markup.jpg', mimeType: 'image/jpeg', buffer: photo })
    await page.getByTestId('photo-run').click()
    // the import runs as the dialog shows it (find the sheet), instead of failing on the sheet that is gone
    await expect(page.getByTestId('photo-import')).toHaveAttribute('data-phase', 'done', { timeout: 200_000 })
    await expect(page.getByTestId('photo-error')).toHaveCount(0)
    const strokes = (await page.evaluate(() => window.__brush!.strokes())) as Stroke[]
    expect(strokes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(strokes.map((s) => s.sheetId))).toEqual(new Set(['sheet-0']))
  })
})
