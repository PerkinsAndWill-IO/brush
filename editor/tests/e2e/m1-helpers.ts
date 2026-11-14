/** Shared helpers for the M1 (canvas lane) e2e specs. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { StrokeRecording } from '../../src/core/types'
import { openApp } from './helpers'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const fixturePath = (rel: string) => resolve(ROOT, 'fixtures', rel)

export function readRecording(rel: string): StrokeRecording {
  return JSON.parse(readFileSync(fixturePath(`strokes/${rel}`), 'utf8')) as StrokeRecording
}

export async function openWith(page: Page, pdf: 'office-1-sheet.pdf' | 'office-6-sheets.pdf') {
  await openApp(page)
  await page.evaluate((u) => window.__brush!.loadPdf(u), `/fixtures/pdfs/${pdf}`)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="sheet"][data-rendered="true"]').length === window.__brush!.sheets().length)
}

/** A synthetic straight stroke on sheet `sheet`, in sheet points. */
export function line(pdf: string, sheet: number, from: [number, number], to: [number, number], n = 24, opts: Partial<StrokeRecording> = {}): StrokeRecording {
  return {
    pdf,
    sheet,
    label: { kind: 'markup' },
    points: Array.from({ length: n }, (_, i) => ({
      x: from[0] + ((to[0] - from[0]) * i) / (n - 1),
      y: from[1] + ((to[1] - from[1]) * i) / (n - 1),
      t: i * 8,
    })),
    ...opts,
  }
}

export const replay = (page: Page, rec: StrokeRecording, realtime = false) =>
  page.evaluate(([r, rt]) => window.__brush!.replayStroke(r, { realtime: rt }), [rec, realtime] as const)

export const strokes = (page: Page) => page.evaluate(() => window.__brush!.strokes())
export const camera = (page: Page) => page.evaluate(() => window.__brush!.camera())

/** Center of the board viewport in page coordinates. */
export async function boardCenter(page: Page) {
  const box = (await page.getByTestId('board').boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

/** Let the camera settle (SETTLE_MS = 180) and pending renders finish. */
export async function settle(page: Page) {
  await page.waitForTimeout(260)
  await page.evaluate(() => window.__brushDev!.frames(2))
}

/** Committed strokes painted on the board (sum over the per-sheet ink canvases). */
export const inkCount = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-layer="ink"]')].reduce((n, el) => n + Number(el.dataset.inkCount ?? 0), 0))

/**
 * Sample the committed-ink canvas of a sheet. For each sheet point returns the
 * RGBA there, and for `column` the number of inked pixels (in sheet pts) on a
 * vertical line through the point (= local stroke thickness).
 */
export const sampleInk = (page: Page, sheetId: string, pts: { x: number; y: number }[]) =>
  page.evaluate(
    ([id, ps]) => {
      const c = document.querySelector<HTMLCanvasElement>(`[data-sheet-id="${id}"] canvas[data-layer="ink"]`)!
      const s = Number(c.dataset.inkScale)
      const g = c.getContext('2d')!
      return ps.map((p) => {
        const px = Math.round(p.x * s)
        const col = g.getImageData(px, Math.max(0, Math.round((p.y - 20) * s)), 1, Math.round(40 * s)).data
        let inked = 0
        for (let i = 3; i < col.length; i += 4) if (col[i] > 127) inked++
        const [r, gg, b, a] = g.getImageData(px, Math.round(p.y * s), 1, 1).data
        return { rgba: [r, gg, b, a], thickness: inked / s }
      })
    },
    [sheetId, pts] as const,
  )
