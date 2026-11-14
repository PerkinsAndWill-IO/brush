import { expect, test } from '@playwright/test'
import { openApp, screenPath } from './helpers'

// Real project bundle (3 A0 sheets from Revit: vector plan with 206k operators, elevation with ~157 image tiles,
// raster axonometric). Decision 0006. Raster-heavy sheets show an image-less preview first and the full render
// later; titles come from the title block. The 2 s first-sheet and 1 s context budgets are defined on the office
// fixtures; on this bundle the times are logged (pdf.js parse of the vector plan alone is ~3 s, see 0006 "Open").
const KRO = '/fixtures/pdfs/kro-project-3-sheets.pdf'

test.setTimeout(300_000)

test('M1-01 KRO bundle: first sheet visible, all sheets fully rendered eventually, names from title blocks', async ({ page }) => {
  await openApp(page)
  const firstMs = await page.evaluate(async (url) => {
    const t0 = performance.now()
    await window.__brush!.loadPdf(url)
    return performance.now() - t0
  }, KRO)
  console.log(`KRO first sheet visible: ${Math.round(firstMs)} ms`)
  // regression guard only (was ~46 s before 0006)
  expect(firstMs).toBeLessThan(15_000)
  await page.screenshot({ path: screenPath('context-kro-first') })

  const sheets = await page.evaluate(() => window.__brush!.sheets())
  expect(sheets.map((s) => s.number)).toEqual([
    'KRO-APD-ARC-PLN-A1A-N01-0001-007',
    'KRO-APD-ARC-ELE-A1A-TTN-0032-005',
    'KRO-APD-ARC-SYN-A1A-TTN-0061-004',
  ])
  expect(sheets[0].name).toContain('PLAN GENERAL')
  expect(sheets[1].name).toContain('ÉLÉVATION')
  expect(sheets[2].name).toContain('AXONOMETRIE')

  const t1 = Date.now()
  // every sheet rendered, and no canvas still showing the image-less preview
  await page.waitForFunction(
    () => {
      const els = [...document.querySelectorAll('[data-testid="sheet"]')]
      return els.length === 3 && els.every((e) => e.getAttribute('data-rendered') === 'true' && !e.querySelector('canvas[data-preview]'))
    },
    undefined,
    { timeout: 200_000, polling: 250 },
  )
  console.log(`KRO all sheets fully rendered after a further ${Date.now() - t1} ms`)
  await page.screenshot({ path: screenPath('context-kro-full') })
})

test('M2-01 KRO contexts: sheet types from title blocks; walls on the plan, none on elevation and axonometric', async ({ page }) => {
  await openApp(page)
  const r = await page.evaluate(async (url) => {
    // @ts-expect-error resolved by the Vite dev server in the browser, not by tsc
    const mod = await import(/* @vite-ignore */ '/src/app/context/client.ts')
    const client = mod.createContextClient()
    await client.open(url)
    const out = []
    for (const id of ['sheet-0', 'sheet-1', 'sheet-2']) {
      const t0 = performance.now()
      const ctx = await client.getContext(id)
      const info = ctx.items.find((i: { props?: Record<string, string> }) => i.props?.role === 'sheet-info')
      out.push({
        ms: performance.now() - t0,
        walls: ctx.items.filter((i: { kind: string }) => i.kind === 'wall').length,
        openings: ctx.items.filter((i: { kind: string }) => i.kind === 'opening').length,
        scale: ctx.scale ?? null,
        sheetType: info?.props?.sheetType,
      })
    }
    client.close()
    return out
  }, KRO)
  console.log(JSON.stringify(r))
  expect(r.map((x) => x.sheetType)).toEqual(['plan', 'elevation', 'axonometric'])
  expect(r[1].walls + r[1].openings + r[2].walls + r[2].openings).toBe(0)
  expect(r.map((x) => x.scale)).toEqual([100, 100, null])
  expect(r[0].walls).toBeGreaterThan(300)
  // regression guard only (was 8-42 s per sheet before 0006)
  for (const x of r) expect(x.ms).toBeLessThan(10_000)
})
