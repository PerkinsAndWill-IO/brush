import { expect, test } from '@playwright/test'
import { openApp, recordPerf, screenPath } from './helpers'

// Drives the context worker client directly (module import through the dev server), so it does not depend
// on the canvas wiring. M2-01, M2-06, M2-09.
async function build(page: import('@playwright/test').Page, url: string, sheetId: string) {
  return page.evaluate(
    async ({ url, sheetId }) => {
      // @ts-expect-error resolved by the Vite dev server in the browser, not by tsc
      const mod = await import(/* @vite-ignore */ '/src/app/context/client.ts')
      const client = mod.createContextClient()
      await client.open(url)
      const t0 = performance.now()
      const ctx = await client.getContext(sheetId)
      const wall = performance.now() - t0
      const t1 = performance.now()
      const again = await client.getContext(sheetId)
      const cached = performance.now() - t1
      const result = {
        items: ctx.items.length,
        walls: ctx.items.filter((i: { kind: string }) => i.kind === 'wall').length,
        grids: ctx.items.filter((i: { kind: string }) => i.kind === 'grid').length,
        scale: ctx.scale ?? null,
        shapeOnly: !!ctx.shapeOnly,
        buildMs: client.buildMs(sheetId) ?? -1,
        wall,
        cached,
        same: again === ctx,
      }
      client.close()
      return result
    },
    { url, sheetId },
  )
}

test('M2-01/M2-09 context for office-1-sheet is built in the worker, cached, under 1 s', async ({ page }) => {
  await openApp(page)
  const r = await build(page, '/fixtures/pdfs/office-1-sheet.pdf', 'sheet-0')
  expect(r.walls).toBeGreaterThanOrEqual(10)
  expect(r.grids).toBeGreaterThanOrEqual(9)
  expect(r.scale).toBe(100)
  expect(r.same).toBe(true)
  expect(r.buildMs).toBeGreaterThan(0)
  expect(r.wall).toBeLessThan(1000)
  recordPerf({ contextBuildMs: r.wall })
  await page.screenshot({ path: screenPath('context-worker') })
})

test('M2-06 scanned page gives an empty shapeOnly context', async ({ page }) => {
  await openApp(page)
  const r = await build(page, '/fixtures/pdfs/scanned-1-sheet.pdf', 'sheet-0')
  expect(r.shapeOnly).toBe(true)
  expect(r.items).toBe(0)
})
