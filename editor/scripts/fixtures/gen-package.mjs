#!/usr/bin/env node
// Builds the `.drawing` fixtures the way an exporter would (format: schema/schema/drawing-format-legacy.md; decision 0008):
//
//   node scripts/fixtures/gen-package.mjs        (run gen-pdfs.mjs first)
//
// From fixtures/pdfs/<name>.truth.json it writes
//   fixtures/packages/<name>.drawing        binary .drawing: gzip(DRAWING\0, version, JSON header, f32 blobs)
//   fixtures/packages/<name>.idmap.json     truth id -> host element id (label derivation for tests/eval/run-commands.ts)
//
// Each sheet is drawn like its PDF twin, but every item names the host element it belongs to:
//   walls       double: two parallel lines; thick: a solid fill (poche). Walls carry CURVE_ELEM_LENGTH (mm) like a
//               Revit export, which is how the Editor finds the scale of a sheet (sheets have no scale field).
//   doors       jambs across the wall, the leaf at 90 degrees and its swing arc
//   furniture   outline (rectangle or circle); rooms: a pale colour fill; grids: dash-dot line, bubble and label
//   room labels text of a RoomTag that tags the room; dimensions, title block and frame as annotation elements;
//   hatches     lines with no element (el: null)
// Coordinates: truth is in sheet points (top-left, y down); the file stores paper feet (y up): x/864, (H - y)/864.
// Deterministic (gzip level 9, no timestamps). No dependencies beyond node:zlib.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PDFS = join(ROOT, 'fixtures', 'pdfs')
const OUT = join(ROOT, 'fixtures', 'packages')
const PACKAGES = ['office-6-sheets', 'office-1-sheet']
const PT_PER_FT = 864
const CAP_EM = 0.716

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
const ROOM_COLOURS = [
  [222, 235, 247],
  [229, 245, 224],
  [254, 237, 222],
  [242, 240, 247],
  [255, 255, 204],
]

// ───────────────────────────── container ─────────────────────────────

/** Blobs, each starting at a multiple of 4 from the buffer start. */
class Blobs {
  constructor() {
    this.parts = []
    this.size = 0
  }
  /** f32 little-endian blob of flat numbers; returns [byteOffset, byteLength]. */
  f32(values) {
    const b = Buffer.alloc(values.length * 4)
    values.forEach((v, i) => b.writeFloatLE(v, 4 * i))
    const at = this.size
    this.parts.push(b)
    this.size += b.length // always a multiple of 4
    return [at, b.length]
  }
  bytes() {
    return Buffer.concat(this.parts)
  }
}

function container(header, buffer) {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const pre = Buffer.alloc(16)
  pre.write('DRAWING\0', 0, 'latin1')
  pre.writeUInt32LE(1, 8)
  pre.writeUInt32LE(json.length, 12)
  const pad = Buffer.alloc((4 - ((16 + json.length) % 4)) % 4)
  return gzipSync(Buffer.concat([pre, json, pad, buffer]), { level: 9 })
}

// ───────────────────────────── one sheet ─────────────────────────────

function sheetPage(s, blobs, elements, idmap) {
  const H = s.sizePt.h
  const X = (x) => x / PT_PER_FT
  const Y = (y) => (H - y) / PT_PER_FT
  const flat = (pts) => pts.flatMap((p) => [X(p.x), Y(p.y)])
  const ft = (pt) => pt / PT_PER_FT
  const base = 100000 + s.pageIndex * 10000
  const view = 800000 + s.pageIndex
  const ppm = s.ptPerMeter
  const items = []
  const host = (truthId, n, off, info) => {
    const id = base + off + n
    if (truthId) idmap[`${s.pageIndex}:${truthId}`] = String(id)
    elements[String(id)] = info
    return id
  }
  const path = (pts, el, o = {}) => items.push({ t: 'path', pts: blobs.f32(flat(pts)), closed: !!o.closed, w: ft(o.w ?? 0.6), c: o.c ?? [0, 0, 0], dash: (o.dash ?? []).map(ft), el, view: o.view === undefined ? view : o.view })
  const segs = (pairs, el, o = {}) => items.push({ t: 'segs', segs: blobs.f32(pairs.flatMap(([a, b]) => [X(a.x), Y(a.y), X(b.x), Y(b.y)])), w: ft(o.w ?? 0.6), c: o.c ?? [0, 0, 0], dash: (o.dash ?? []).map(ft), el, view: o.view === undefined ? view : o.view })
  const fill = (pts, el, c, v = view) => items.push({ t: 'fill', rings: [blobs.f32(flat(pts))], c, el, view: v })
  const text = (str, at, fontPt, el, o = {}) =>
    items.push({ t: 'text', text: str, at: [X(at.x), Y(at.y)], size: ft(fontPt * CAP_EM), anchor: o.anchor ?? 'cm', dir: [1, 0], maxWidth: null, c: o.c ?? [0, 0, 0], bold: !!o.bold, el, view: o.view === undefined ? view : o.view })
  const rectPts = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
  const circlePts = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }))

  // rooms first (colour fills under everything), ids 3000+
  const roomIds = new Map()
  s.rooms.forEach((r, i) => {
    const id = host(null, i, 3000, { class: 'RoomElem', category: 'Rooms', name: r.label, family: null, type: null, level: s.name, params: [{ name: 'ROOM_NAME', value: r.label }] })
    roomIds.set(r.label, id)
    fill(r.polygon, id, ROOM_COLOURS[i % ROOM_COLOURS.length])
  })

  // grids, ids 4000+: dash-dot line, bubble beyond the first end, label
  s.grids.forEach((g, i) => {
    const id = host(g.id, i, 4000, { class: 'Grid', category: 'Grids', name: g.label, family: null, type: null, level: null, params: [] })
    const [a, b] = g.line
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    const c = { x: a.x - u.x * 11, y: a.y - u.y * 11 }
    segs([[a, b]], id, { w: 0.35, c: [140, 140, 140], dash: [14, 3, 2, 3] })
    path(circlePts(c.x, c.y, 11), id, { closed: true, w: 0.6, c: [77, 77, 77] })
    text(g.label, c, 10, id)
  })

  // walls, ids 0+
  const wallInfo = new Map()
  s.walls.forEach((w, i) => {
    const [a, b] = w.centerline
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const t = nearestWall((w.thicknessPt / ppm) * 1000)
    const id = host(w.id, i, 0, {
      class: 'SWall',
      category: 'Walls',
      name: null,
      family: null,
      type: t.name,
      level: s.name,
      params: [
        { name: 'CURVE_ELEM_LENGTH', value: String(Math.round((len / ppm) * 1000)) },
        { name: 'WALL_ATTR_WIDTH_PARAM', value: String(Math.round((w.thicknessPt / ppm) * 1000)) },
      ],
    })
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
    const n = { x: -u.y, y: u.x }
    const h = w.thicknessPt / 2
    const off = (p, k) => ({ x: p.x + n.x * k, y: p.y + n.y * k })
    if (w.style === 'double') segs([[off(a, -h), off(b, -h)], [off(a, h), off(b, h)]], id, { w: 0.6 })
    else fill([off(a, -h), off(b, -h), off(b, h), off(a, h)], id, [0, 0, 0])
    wallInfo.set(w.id, { id, a, u, n, h })
  })

  // doors, ids 1000+: jambs across the wall, leaf at 90 degrees from the hinge, quarter-circle swing to the far jamb
  const doorTypes = new Map()
  s.doors.forEach((d, i) => {
    const w = wallInfo.get(d.wallId)
    const mm = Math.round(((d.widthPt / ppm) * 1000) / 100) * 100
    const type = `${pad4(mm)}x2100`
    doorTypes.set(type, mm)
    const id = host(d.id, i, 1000, { class: 'FamilyInstance', category: 'Doors', name: 'Single-Flush', family: 'Single-Flush', type, level: s.name, params: [{ name: 'HOST_ID', value: String(w.id) }] })
    const half = d.widthPt / 2
    const p0 = { x: d.at.x - w.u.x * half, y: d.at.y - w.u.y * half }
    const p1 = { x: d.at.x + w.u.x * half, y: d.at.y + w.u.y * half }
    const jamb = (p) => [{ x: p.x - w.n.x * w.h, y: p.y - w.n.y * w.h }, { x: p.x + w.n.x * w.h, y: p.y + w.n.y * w.h }]
    segs([jamb(p0), jamb(p1)], id, { w: 0.6 })
    const tip = { x: p0.x + w.n.x * d.widthPt, y: p0.y + w.n.y * d.widthPt }
    segs([[p0, tip]], id, { w: 1, c: [26, 26, 26] })
    const arc = Array.from({ length: 17 }, (_, k) => {
      const ang = (Math.PI / 2) * (k / 16)
      const cu = Math.sin(ang) * d.widthPt // along the wall
      const cn = Math.cos(ang) * d.widthPt // off the wall
      return { x: p0.x + w.u.x * cu + w.n.x * cn, y: p0.y + w.u.y * cu + w.n.y * cn }
    })
    path(arc, id, { w: 0.4, c: [26, 26, 26] })
  })

  // furniture, ids 2000+
  s.furniture.forEach((fu, i) => {
    const { x, y, w, h } = fu.bbox
    const wMm = mm50(w / ppm)
    const hMm = mm50(h / ppm)
    const type = fu.shape === 'circle' ? `${KIND_NAME[fu.kind]} Round ${wMm}` : `${KIND_NAME[fu.kind]} ${wMm}x${hMm}`
    const id = host(fu.id, i, 2000, { class: 'FamilyInstance', category: 'Furniture', name: KIND_NAME[fu.kind], family: KIND_NAME[fu.kind], type, level: s.name, params: [] })
    const pts = fu.shape === 'rect' ? rectPts(x, y, w, h) : circlePts(x + w / 2, y + h / 2, w / 2)
    path(pts, id, { closed: true, w: 0.7, c: [38, 38, 38] })
  })

  // room labels, ids 5000+: room tags that tag their room; other labels are text notes
  s.labels.forEach((l, i) => {
    const room = roomIds.get(l.text)
    const info = room
      ? { class: 'RoomTag', category: 'Room Tags', name: null, family: null, type: null, level: null, tagged: room, params: [] }
      : { class: 'TextNote', category: 'Text Notes', name: null, family: null, type: null, level: null, params: [] }
    text(l.text, l.at, 7, host(null, i, 5000, info))
  })

  // dimensions, ids 6000+
  ;(s.distractors?.dimensions ?? []).forEach((d, i) => {
    const id = host(null, i, 6000, { class: 'LinearDimString', category: 'Dimensions', name: null, family: null, type: 'Linear - 2.5mm Arial', level: null, params: [] })
    const [a, b] = d.line
    segs([[a, b], ...[a, b].map((p) => [{ x: p.x - 3, y: p.y + 3 }, { x: p.x + 3, y: p.y - 3 }])], id, { w: 0.35, c: [89, 89, 89] })
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    if (d.vertical) text(String(d.valueMm), { x: m.x + 4, y: m.y }, 6, id, { anchor: 'lm', c: [51, 51, 51] })
    else text(String(d.valueMm), { x: m.x, y: m.y - 3 }, 6, id, { anchor: 'cb', c: [51, 51, 51] })
  })

  // hatches: plain linework, no element
  for (const hb of s.distractors?.hatches ?? []) {
    const { x, y, w, h } = hb.bbox
    const lines = []
    // 45 degree lines from the bottom edge up and right, clipped to the box (as the PDF draws them)
    for (let k = -h; k < w; k += 4) {
      const s0 = Math.max(0, -k)
      const s1 = Math.min(h, w - k)
      if (s1 > s0) lines.push([{ x: x + k + s0, y: y + h - s0 }, { x: x + k + s1, y: y + h - s1 }])
    }
    segs(lines, null, { w: 0.3, c: [102, 102, 102] })
    path(rectPts(x, y, w, h), null, { closed: true, w: 0.6, c: [51, 51, 51] })
  }

  // frame and title block (sheet space: no view), ids 9000
  const tb = s.distractors?.titleBlock ?? { x: 965, y: 30, w: 201, h: 782 }
  const tbId = host(null, 0, 9000, { class: 'FamilyInstance', category: 'Title Blocks', name: 'A3 metric', family: 'A3 metric', type: 'A3 metric', level: null, params: [] })
  path(rectPts(25, 25, 1141, 792), tbId, { closed: true, w: 1.2, view: null })
  path(rectPts(tb.x, tb.y, tb.w, tb.h), tbId, { closed: true, w: 0.8, view: null })
  segs([120, 200, 560, 640, 700, 750].map((yy) => [{ x: tb.x, y: yy }, { x: tb.x + tb.w, y: yy }]), tbId, { w: 0.8, view: null })
  const cx = tb.x + tb.w / 2
  const tbText = [
    ['ACME ARCHITECTS', 80, 13],
    ['FIXTURE PROJECT - OFFICE', 100, 8],
    [`LEVEL ${s.number.replace(/\D/g, '').slice(0, 1)}`, 590, 9],
    ['DRAWN BY  FIXTURES', 620, 7],
    [`SCALE ${s.scale}`, 676, 11],
    [s.name.toUpperCase(), 730, 11],
    [s.number, 785, 30],
  ]
  for (const [str, yy, size] of tbText) text(str, { x: cx, y: yy - 0.35 * size }, size, tbId, { view: null })

  return {
    id: 900000 + s.pageIndex,
    kind: 'sheet',
    number: s.number,
    name: s.name,
    scale: null, // sheets carry no scale; the Editor estimates it from wall lengths
    min: [0, 0],
    max: [s.sizePt.w / PT_PER_FT, s.sizePt.h / PT_PER_FT],
    items,
  }
}

function build(name) {
  const truth = JSON.parse(readFileSync(join(PDFS, `${name}.truth.json`), 'utf8'))
  const blobs = new Blobs()
  const elements = {}
  const idmap = {}
  const pages = truth.sheets.map((s) => sheetPage(s, blobs, elements, idmap))
  const header = { format: 'drawing', version: 1, source: { file: 'fixture-office.rvt', generator: 'brush gen-package.mjs' }, pages, elements }
  return { bytes: container(header, blobs.bytes()), idmap, pages: pages.length, elements: Object.keys(elements).length }
}

mkdirSync(OUT, { recursive: true })
for (const name of PACKAGES) {
  const { bytes, idmap, pages, elements } = build(name)
  writeFileSync(join(OUT, `${name}.drawing`), bytes)
  const sorted = Object.fromEntries(Object.entries(idmap).sort((x, y) => Number(x[1]) - Number(y[1])))
  writeFileSync(join(OUT, `${name}.idmap.json`), JSON.stringify(sorted, null, 1))
  console.log(`${name}.drawing: ${pages} sheets, ${elements} elements, ${bytes.length} bytes`)
}
