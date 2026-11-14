// Validates fixtures/pdfs with pdfjs-dist (if installed): page count, operator list, text.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'pdfs')
let pdfjs
try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') } catch { console.log('pdfjs-dist not installed; skipping'); process.exit(0) }
for (const n of ['office-6-sheets', 'office-1-sheet', 'scanned-1-sheet', 'corrupt']) {
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(dir, n + '.pdf'))), verbosity: 0 }).promise
    const labels = await doc.getPageLabels()
    const p = await doc.getPage(1)
    const ops = await p.getOperatorList()
    const tc = await p.getTextContent()
    const OPS = pdfjs.OPS
    const count = (o) => ops.fnArray.filter((x) => x === o).length
    console.log(n, 'pages', doc.numPages, 'labels', JSON.stringify(labels), 'ops', ops.fnArray.length,
      'constructPath', count(OPS.constructPath), 'image', count(OPS.paintImageXObject), 'text', tc.items.length)
  } catch (e) { console.log(n, 'ERROR (expected for corrupt):', e.message) }
}
