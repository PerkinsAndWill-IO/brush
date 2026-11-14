/**
 * Build SheetContext fixtures headlessly (pdf.js legacy build in Node).
 *   pnpm exec tsx scripts/build-contexts.ts
 * For each fixtures/pdfs/*.pdf (corrupt ones skipped) and page writes
 *   fixtures/contexts/<pdf>.<page>.raw.json  RawPageContent (cache for unit tests)
 *   fixtures/contexts/<pdf>.<page>.json      SheetContext from inferContext (read by tests/eval/run-eval.ts)
 * and reports/context-build.json with per-sheet timings.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPageContent, type PdfOps, type PdfPageLike } from '../src/app/context/extract'
import { inferContext } from '../src/core/context'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pdfDir = resolve(root, 'fixtures', 'pdfs')
const outDir = resolve(root, 'fixtures', 'contexts')
mkdirSync(outDir, { recursive: true })
mkdirSync(resolve(root, 'reports'), { recursive: true })

const timings: Array<{ pdf: string; page: number; extractMs: number; inferMs: number; totalMs: number; paths: number; items: number }> = []

for (const file of readdirSync(pdfDir).filter((f) => f.endsWith('.pdf'))) {
  const data = new Uint8Array(readFileSync(resolve(pdfDir, file)))
  let doc
  let task
  try {
    task = getDocument({ data, verbosity: 0 })
    doc = await task.promise
  } catch (e) {
    console.log(`skip ${file}: ${(e as Error).message}`)
    continue
  }
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1)
    const t0 = performance.now()
    const raw = await extractPageContent(page as unknown as PdfPageLike, `sheet-${i}`, OPS as unknown as PdfOps)
    const t1 = performance.now()
    const ctx = inferContext(raw)
    const t2 = performance.now()
    writeFileSync(resolve(outDir, `${file}.${i}.raw.json`), JSON.stringify(raw))
    writeFileSync(resolve(outDir, `${file}.${i}.json`), JSON.stringify(ctx))
    timings.push({ pdf: file, page: i, extractMs: +(t1 - t0).toFixed(1), inferMs: +(t2 - t1).toFixed(1), totalMs: +(t2 - t0).toFixed(1), paths: raw.paths.length, items: ctx.items.length })
    console.log(`${file}[${i}] paths=${raw.paths.length} texts=${raw.texts.length} items=${ctx.items.length} shapeOnly=${!!ctx.shapeOnly} extract=${(t1 - t0).toFixed(0)}ms infer=${(t2 - t1).toFixed(0)}ms`)
  }
  await task.destroy()
}
writeFileSync(resolve(root, 'reports', 'context-build.json'), JSON.stringify({ generatedAt: new Date().toISOString(), timings }, null, 2))
