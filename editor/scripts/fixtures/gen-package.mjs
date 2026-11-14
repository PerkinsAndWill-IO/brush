#!/usr/bin/env node
// Builds `.drawing` fixture packages the way an Exporter would (decision 0005, 0002):
//
//   node scripts/fixtures/gen-package.mjs        (run gen-pdfs.mjs first)
//
// From fixtures/pdfs/<name>.pdf + <name>.truth.json it writes
//   fixtures/packages/<name>.drawing        JSON envelope: manifest + PDF base64 (zero-dep container)
//   fixtures/packages/<name>.idmap.json     truth id -> host element id (label derivation for tests/eval/run-commands.ts)
// Exact footprints, numeric host-like element ids, type names from the palette, sheet numbers/names, scale.
// Deterministic. No dependencies.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PDFS = join(ROOT, 'fixtures', 'pdfs')
const OUT = join(ROOT, 'fixtures', 'packages')
const PACKAGES = ['office-6-sheets', 'office-1-sheet']

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d
const mm50 = (m) => Math.round((m * 1000) / 50) * 50
const pad4 = (n) => String(n).padStart(4, '0')

const WALL_TYPES = [
  { name: 'Partition - 100mm', thicknessMm: 100 },
  { name: 'Interior - 150mm', thicknessMm: 150 },
  { name: 'Generic - 200mm', thicknessMm: 200 },
  { name: 'Exterior - 300mm', thicknessMm: 300 },
  { name: 'Concrete - 400mm', thicknessMm: 400 },
]
const nearestWall = (mm) => WALL_TYPES.reduce((a, b) => (Math.abs(b.thicknessMm - mm) < Math.abs(a.thicknessMm - mm) ? b : a))
const KIND_NAME = { desk: 'Desk', chair: 'Chair', cabinet: 'Cabinet', table: 'Table', shelf: 'Shelf', wc: 'WC' }

function build(name) {
  const truth = JSON.parse(readFileSync(join(PDFS, `${name}.truth.json`), 'utf8'))
  const doors = new Map()
  const furn = new Map()
  const idmap = {}
  const sheets = truth.sheets.map((s) => {
    const base = 100000 + s.pageIndex * 10000
    const ppm = s.ptPerMeter
    const scaleDen = Number(String(s.scale).split(':')[1])
    const els = []
    const host = (truthId, n, off) => {
      const id = String(base + off + n)
      if (truthId) idmap[`${s.pageIndex}:${truthId}`] = id
      return id
    }
    const wallById = new Map(s.walls.map((w) => [w.id, w]))
    s.walls.forEach((w, i) => {
      const t = nearestWall((w.thicknessPt / ppm) * 1000)
      els.push({ id: host(w.id, i, 0), category: 'Walls', typeName: t.name, footprint: w.centerline, props: { thicknessMm: String(Math.round((w.thicknessPt / ppm) * 1000)) } })
    })
    s.doors.forEach((d, i) => {
      const w = wallById.get(d.wallId)
      const [a, b] = w.centerline
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const ux = (b.x - a.x) / len
      const uy = (b.y - a.y) / len
      const h = d.widthPt / 2
      const mm = Math.round(((d.widthPt / ppm) * 1000) / 100) * 100
      const type = `Single-Flush ${pad4(mm)}x2100`
      doors.set(type, { name: type, widthMm: mm, heightMm: 2100 })
      els.push({
        id: host(d.id, i, 1000),
        category: 'Doors',
        typeName: type,
        footprint: [
          { x: round(d.at.x - ux * h), y: round(d.at.y - uy * h) },
          { x: round(d.at.x + ux * h), y: round(d.at.y + uy * h) },
        ],
        props: { hostWall: String(base + s.walls.indexOf(w)) },
      })
    })
    s.furniture.forEach((f, i) => {
      const { x, y, w, h } = f.bbox
      const wMm = mm50(w / ppm)
      const hMm = mm50(h / ppm)
      const type = f.shape === 'circle' ? `${KIND_NAME[f.kind]} Round ${wMm}` : `${KIND_NAME[f.kind]} ${wMm}x${hMm}`
      furn.set(type, { name: type, widthMm: wMm, depthMm: hMm })
      els.push({
        id: host(f.id, i, 2000),
        category: 'Furniture',
        typeName: type,
        footprint: [
          { x, y },
          { x: round(x + w), y },
          { x: round(x + w), y: round(y + h) },
          { x, y: round(y + h) },
        ],
      })
    })
    s.rooms.forEach((r, i) => els.push({ id: host(null, i, 3000), category: 'Rooms', label: r.label, footprint: r.polygon, props: { level: s.name } }))
    s.grids.forEach((g, i) => els.push({ id: host(g.id, i, 4000), category: 'Grids', label: g.label, footprint: g.line }))
    s.labels.forEach((l, i) => els.push({ id: host(null, i, 5000), category: 'Text', label: l.text, footprint: [l.at] }))
    return { id: s.number, number: s.number, name: s.name, sizePt: s.sizePt, scale: scaleDen, elements: els }
  })
  const manifest = {
    schemaVersion: 1,
    project: 'Fixture Office',
    palette: { walls: WALL_TYPES, doors: [...doors.values()].sort((a, b) => a.widthMm - b.widthMm), furniture: [...furn.values()].sort((a, b) => a.name.localeCompare(b.name)) },
    sheets,
  }
  const pdf = readFileSync(join(PDFS, `${name}.pdf`))
  const env = { ...manifest, pdf: { name: `${name}.pdf`, encoding: 'base64', data: pdf.toString('base64') } }
  return { env, idmap, count: sheets.reduce((a, s) => a + s.elements.length, 0) }
}

mkdirSync(OUT, { recursive: true })
for (const name of PACKAGES) {
  const { env, idmap, count } = build(name)
  writeFileSync(join(OUT, `${name}.drawing`), JSON.stringify(env))
  writeFileSync(join(OUT, `${name}.idmap.json`), JSON.stringify(idmap, null, 1))
  console.log(`${name}.drawing: ${env.sheets.length} sheets, ${count} elements`)
}
