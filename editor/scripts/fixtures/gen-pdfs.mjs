#!/usr/bin/env node
// Zero-dependency generator for the Brush Editor PDF fixtures.
//
//   node scripts/fixtures/gen-pdfs.mjs
//
// Writes fixtures/pdfs/{office-6-sheets,office-1-sheet,scanned-1-sheet,corrupt}.pdf,
// not-a-pdf.txt and <name>.truth.json (ground truth in SHEET coordinates:
// top-left origin, y down, PDF points). Deterministic (seeded PRNG).

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'fixtures', 'pdfs')
mkdirSync(OUT, { recursive: true })

const PAGE_W = 1191
const PAGE_H = 842
const M = 28.3465 // pt per metre at 1:100 (1 m -> 10 mm on paper)
const DOUBLE_GAP = 7 // pt between parallel lines of a double wall (~0.25 m)
const THICK_LW = 2.5 // single stroke thick wall line width (pt)

// ───────────────────────────── utils ─────────────────────────────

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const r2 = (n) => Math.round(n * 100) / 100
const pt = (x, y) => ({ x: r2(x), y: r2(y) })
const f = (n) => String(+n.toFixed(2))
const esc = (s) => s.replace(/([()\\])/g, '\\$1')

// ───────────────────────────── PDF writer ─────────────────────────────

class PdfWriter {
  constructor() {
    this.objs = [null] // 1-based
  }
  alloc() {
    this.objs.push(null)
    return this.objs.length - 1
  }
  set(id, body) {
    this.objs[id] = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')
  }
  stream(dict, data) {
    return Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ])
  }
  build(rootId) {
    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
    let off = parts[0].length
    const offsets = [0]
    for (let i = 1; i < this.objs.length; i++) {
      offsets[i] = off
      const b = Buffer.concat([Buffer.from(`${i} 0 obj\n`, 'latin1'), this.objs[i], Buffer.from('\nendobj\n', 'latin1')])
      parts.push(b)
      off += b.length
    }
    const n = this.objs.length
    let xref = `xref\n0 ${n}\n0000000000 65535 f \n`
    for (let i = 1; i < n; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
    xref += `trailer\n<< /Size ${n} /Root ${rootId} 0 R >>\nstartxref\n${off}\n%%EOF\n`
    parts.push(Buffer.from(xref, 'latin1'))
    return Buffer.concat(parts)
  }
}

// ───────────────────────────── drawing context (sheet coords, y down) ─────────────────────────────

class Ctx {
  constructor() {
    this.o = []
  }
  X(x) {
    return f(x)
  }
  Y(y) {
    return f(PAGE_H - y)
  }
  raw(s) {
    this.o.push(s)
  }
  lw(w) {
    this.raw(`${f(w)} w`)
  }
  stroke(g) {
    this.raw(`${f(g)} G`)
  }
  fill(g) {
    this.raw(`${f(g)} g`)
  }
  dash(a, ph = 0) {
    this.raw(`[${a.map(f).join(' ')}] ${f(ph)} d`)
  }
  solid() {
    this.raw('[] 0 d')
  }
  line(x0, y0, x1, y1) {
    this.raw(`${this.X(x0)} ${this.Y(y0)} m ${this.X(x1)} ${this.Y(y1)} l S`)
  }
  polyline(pts, close = false) {
    this.raw(pts.map((p, i) => `${this.X(p.x)} ${this.Y(p.y)} ${i ? 'l' : 'm'}`).join(' ') + (close ? ' h S' : ' S'))
  }
  rect(x, y, w, h, mode = 'S') {
    this.raw(`${this.X(x)} ${this.Y(y + h)} ${f(w)} ${f(h)} re ${mode}`)
  }
  /** Bezier arc of |da| <= 90 degrees; assumes current point handling inside. */
  arcPath(cx, cy, r, a0, da, moveTo = true) {
    const k = (4 / 3) * Math.tan(da / 4)
    const a1 = a0 + da
    const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)]
    const p3 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)]
    const p1 = [p0[0] - k * r * Math.sin(a0), p0[1] + k * r * Math.cos(a0)]
    const p2 = [p3[0] + k * r * Math.sin(a1), p3[1] - k * r * Math.cos(a1)]
    const c = (p) => `${this.X(p[0])} ${this.Y(p[1])}`
    return (moveTo ? `${c(p0)} m ` : '') + `${c(p1)} ${c(p2)} ${c(p3)} c`
  }
  arc(cx, cy, r, a0, da) {
    this.raw(this.arcPath(cx, cy, r, a0, da) + ' S')
  }
  circle(cx, cy, r, mode = 'S') {
    let s = ''
    for (let i = 0; i < 4; i++) s += this.arcPath(cx, cy, r, (i * Math.PI) / 2, Math.PI / 2, i === 0) + ' '
    this.raw(s + 'h ' + mode)
  }
  text(x, y, s, size, align = 'c', font = 'F1') {
    const w = textWidth(s, size)
    const x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x
    this.raw(`BT /${font} ${f(size)} Tf ${this.X(x0)} ${this.Y(y)} Td (${esc(s)}) Tj ET`)
  }
  toString() {
    return this.o.join('\n')
  }
}

function textWidth(s, size) {
  let w = 0
  for (const ch of s) w += /[A-Z0-9]/.test(ch) ? 0.68 : ch === ' ' || ch === '-' || ch === '.' ? 0.3 : 0.52
  return w * size
}

// ───────────────────────────── floor plan model ─────────────────────────────

const ROOM_TYPES = ['OFFICE', 'MEETING', 'OPEN OFFICE', 'STORAGE', 'OFFICE', 'OFFICE']

/**
 * Build one sheet's model. Plan is authored in metres then transformed (optional
 * mirror) to sheet points. Returns { truth, draw(ctx), raster(rastCtx) }.
 */
function buildSheet({ pageIndex, level, variant, pageCount, sheetNo }) {
  const rng = mulberry32(1000 + variant * 77 + level)
  const W = 26 + (variant % 3) * 1.5
  const H = 20
  const cy = 7 + (variant % 3) // corridor north edge
  const CW = 2.4 // corridor width
  const CORE = 6
  const flipX = variant % 2 === 1
  const flipY = ((variant >> 1) & 1) === 1
  const ox = 105
  const oy = 120
  const TX = (m) => ox + (flipX ? W - m : m) * M
  const TY = (m) => oy + (flipY ? H - m : m) * M
  const T = (mx, my) => ({ x: TX(mx), y: TY(my) })
  const sideT = (s) => ({ x: flipX ? -s.x : s.x, y: flipY ? -s.y : s.y })

  const walls = []
  const doors = []
  const furniture = []
  const rooms = []
  const labels = []
  const decor = [] // generic distractor primitives for both renderers
  let wid = 0
  let did = 0
  let fid = 0

  const addWall = (a, b, style, ext = false) => {
    const p0 = T(a[0], a[1])
    const p1 = T(b[0], b[1])
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    const w = {
      id: `w${pageIndex}-${wid++}`,
      p0,
      p1,
      len,
      u: { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len },
      style,
      thickness: style === 'double' ? DOUBLE_GAP : THICK_LW,
      ext,
      gaps: [],
    }
    walls.push(w)
    return w
  }
  const addDoor = (w, cm, widthM, sideM) => {
    const c = T(cm[0], cm[1])
    const wpt = widthM * M
    const t = (c.x - w.p0.x) * w.u.x + (c.y - w.p0.y) * w.u.y
    w.gaps.push([t - wpt / 2, t + wpt / 2])
    const s = sideT({ x: sideM[0], y: sideM[1] })
    const hingeAtStart = rng() < 0.5
    const hingeT = hingeAtStart ? t - wpt / 2 : t + wpt / 2
    const hinge = { x: w.p0.x + w.u.x * hingeT, y: w.p0.y + w.u.y * hingeT }
    const alongDir = hingeAtStart ? 1 : -1
    const a0 = Math.atan2(s.y, s.x)
    const a1 = Math.atan2(w.u.y * alongDir, w.u.x * alongDir)
    let da = a1 - a0
    while (da > Math.PI) da -= 2 * Math.PI
    while (da < -Math.PI) da += 2 * Math.PI
    doors.push({
      id: `d${pageIndex}-${did++}`,
      wallId: w.id,
      at: pt(c.x, c.y),
      widthPt: r2(wpt),
      hinge: pt(hinge.x, hinge.y),
      swingSide: { x: s.x, y: s.y },
      _arc: { cx: hinge.x, cy: hinge.y, r: wpt, a0, da },
    })
  }
  const rectBox = (x, y, w, h) => {
    const a = T(x, y)
    const b = T(x + w, y + h)
    return { x: r2(Math.min(a.x, b.x)), y: r2(Math.min(a.y, b.y)), w: r2(Math.abs(b.x - a.x)), h: r2(Math.abs(b.y - a.y)) }
  }
  const addRect = (kind, x, y, w, h) => {
    furniture.push({ id: `f${pageIndex}-${fid++}`, kind, shape: 'rect', bbox: rectBox(x, y, w, h) })
  }
  const addCircle = (kind, x, y, r) => {
    const c = T(x, y)
    furniture.push({
      id: `f${pageIndex}-${fid++}`,
      kind,
      shape: 'circle',
      bbox: { x: r2(c.x - r * M), y: r2(c.y - r * M), w: r2(2 * r * M), h: r2(2 * r * M) },
    })
  }
  const addRoom = (label, x0, y0, x1, y1, lx, ly) => {
    const poly = [T(x0, y0), T(x1, y0), T(x1, y1), T(x0, y1)].map((p) => pt(p.x, p.y))
    rooms.push({ label, polygon: poly })
    const lp = T(lx, ly)
    labels.push({ text: label, at: pt(lp.x, lp.y), size: 7 })
  }

  // exterior (double) walls, with end extension so corners close
  const wTop = addWall([0, 0], [W, 0], 'double', true)
  const wRight = addWall([W, 0], [W, H], 'double', true)
  const wBot = addWall([0, H], [W, H], 'double', true)
  const wLeft = addWall([0, 0], [0, H], 'double', true)
  void wTop
  void wBot
  void wLeft
  // core wall (double) and core divider
  const wCore = addWall([CORE, 0], [CORE, H], 'double')
  const wCoreDiv = addWall([0, cy + CW / 2], [CORE, cy + CW / 2], 'thick')
  void wCoreDiv
  // corridor walls (thick)
  const wCN = addWall([CORE, cy], [W, cy], 'thick')
  const wCS = addWall([CORE, cy + CW], [W, cy + CW], 'thick')

  // room splits per row
  const L = W - CORE
  const splitRow = (n) => {
    const base = L / n
    const xs = [CORE]
    for (let i = 1; i < n; i++) xs.push(r2(CORE + base * i + (rng() - 0.5) * 1.0))
    xs.push(W)
    return xs
  }
  const nN = 3 + (variant % 3)
  const nS = 3 + ((variant + 1) % 3)
  const xsN = splitRow(nN)
  const xsS = splitRow(nS)
  for (let i = 1; i < nN; i++) addWall([xsN[i], 0], [xsN[i], cy], 'thick')
  for (let i = 1; i < nS; i++) addWall([xsS[i], cy + CW], [xsS[i], H], 'thick')

  // doors: core + entrance
  addDoor(wCore, [CORE, cy + 0.6], 0.9, [-1, 0])
  addDoor(wCore, [CORE, cy + CW - 0.6], 0.9, [-1, 0])
  addDoor(wRight, [W, cy + CW / 2], 1.4, [-1, 0])

  // names
  const names = []
  for (let i = 0; i < nN + nS; i++) names.push(ROOM_TYPES[Math.floor(rng() * ROOM_TYPES.length)])
  names[1] = 'MEETING'
  names[nN + 1] = 'MEETING'
  let roomNo = 1

  const doRow = (xs, y0, y1, north, offset) => {
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i]
      const x1 = xs[i + 1]
      const type = names[offset + i]
      const label = `${type} ${level * 100 + roomNo++}`
      const cx = (x0 + x1) / 2
      const wallC = north ? wCN : wCS
      const doorY = north ? cy : cy + CW
      addDoor(wallC, [cx, doorY], 0.9, [0, north ? -1 : 1])
      const dir = north ? 1 : -1
      const far = north ? y0 : y1
      const depth = y1 - y0
      // y of a rect anchored `off` m from the far wall with height h
      const fy = (off, h) => (north ? far + off : far - off - h)
      const labelY = north ? y1 - 1.7 : y0 + 1.7
      addRoom(label, x0, y0, x1, y1, cx, labelY)
      if (type === 'OFFICE') {
        addRect('desk', cx - 0.8, fy(0.3, 0.8), 1.6, 0.8)
        addCircle('chair', cx, far + dir * (0.3 + 0.8 + 0.45), 0.22)
        addRect('cabinet', x0 + 0.3, fy(0.3, 1.2), 0.5, 1.2)
        addCircle('table', x1 - 1.1, far + dir * (depth * 0.5), 0.5)
      } else if (type === 'MEETING') {
        const tw = Math.min(3.4, x1 - x0 - 1.6)
        const th = 1.3
        const ty = fy(0.9, th)
        addRect('table', cx - tw / 2, ty, tw, th)
        for (const dx of [-tw / 4, tw / 4]) {
          addCircle('chair', cx + dx, north ? ty - 0.35 : ty + th + 0.35, 0.22)
          addCircle('chair', cx + dx, north ? ty + th + 0.35 : ty - 0.35, 0.22)
        }
        addCircle('chair', cx - tw / 2 - 0.35, ty + th / 2, 0.22)
        addCircle('chair', cx + tw / 2 + 0.35, ty + th / 2, 0.22)
      } else if (type === 'OPEN OFFICE') {
        for (const dx of [-1.9, 0.3]) for (const off of [0.3, 1.9]) addRect('desk', cx + dx, fy(off, 0.8), 1.6, 0.8)
      } else {
        for (let k = 0; k < 3; k++) addRect('shelf', x0 + 0.4 + k * 1.1, fy(0.3, 2.0), 0.4, 2.0)
      }
    }
  }
  doRow(xsN, 0, cy, true, 0)
  doRow(xsS, cy + CW, H, false, nN)

  // core rooms and corridor
  addRoom(`STAIR ${level}`, 0, 0, CORE, cy + CW / 2, CORE / 2, 6.8)
  addRoom('WC', 0, cy + CW / 2, CORE, H, CORE / 2 - 0.5, cy + CW / 2 + 3)
  addRoom('CORRIDOR', CORE, cy, W, cy + CW, (CORE + W) / 2, cy + CW / 2 + 0.25)
  for (let k = 0; k < 3; k++) addRect('wc', 0.4 + k * 1.1, H - 1.7, 0.9, 1.6)
  // stair treads (distractor)
  for (const [xa, xb] of [[0.5, 2.9], [3.1, 5.5]]) {
    for (let k = 0; k < 14; k++) {
      const a = T(xa, 0.6 + k * 0.29)
      const b = T(xb, 0.6 + k * 0.29)
      decor.push({ type: 'line', a, b, lw: 0.4, g: 0.2 })
    }
  }
  {
    const a = T(2.9, 0.6)
    const b = T(3.1, 0.6 + 14 * 0.29)
    decor.push({ type: 'rect', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), lw: 0.4, g: 0.2 })
  }
  // hatch shaft in WC (distractor)
  const shaft = rectBox(3.8, H - 3.5, 1.8, 3.2)
  decor.push({ type: 'hatch', ...shaft })

  // structural grids
  const gxM = [0, CORE, CORE + L / 3, CORE + (2 * L) / 3, W].map((m) => r2(TX(m)))
  const gyM = [0, cy, cy + CW, H].map((m) => r2(TY(m)))
  const gx = [...new Set(gxM)].sort((a, b) => a - b)
  const gy = [...new Set(gyM)].sort((a, b) => a - b)
  const top = oy - 2 * M
  const bottom = oy + H * M + 1 * M
  const left = ox - 2 * M
  const right = ox + W * M + 1 * M
  const grids = []
  gx.forEach((x, i) => {
    grids.push({ id: `g${pageIndex}-${grids.length}`, label: String.fromCharCode(65 + i), line: [pt(x, top), pt(x, bottom)], bubble: pt(x, top - 11) })
  })
  gy.forEach((y, i) => {
    grids.push({ id: `g${pageIndex}-${grids.length}`, label: String(i + 1), line: [pt(left, y), pt(right, y)], bubble: pt(left - 11, y) })
  })

  // dimension chain along bottom (distractor)
  const dimY = oy + H * M + 0.5 * M
  const dims = []
  for (let i = 0; i < gx.length - 1; i++) {
    const mm = Math.round(((gx[i + 1] - gx[i]) / M) * 1000 / 100) * 100
    dims.push({ line: [pt(gx[i], dimY), pt(gx[i + 1], dimY)], valueMm: mm })
  }
  const dimX = ox + W * M + 0.5 * M
  for (let i = 0; i < gy.length - 1; i++) {
    const mm = Math.round(((gy[i + 1] - gy[i]) / M) * 1000 / 100) * 100
    dims.push({ line: [pt(dimX, gy[i]), pt(dimX, gy[i + 1])], valueMm: mm, vertical: true })
  }

  const number = sheetNo
  const name = `Level ${level} Floor Plan`
  const truth = {
    pageIndex,
    number,
    name,
    sizePt: { w: PAGE_W, h: PAGE_H },
    scale: '1:100',
    ptPerMeter: r2(M),
    walls: walls.map((w) => ({
      id: w.id,
      centerline: [pt(w.p0.x, w.p0.y), pt(w.p1.x, w.p1.y)],
      thicknessPt: w.thickness,
      style: w.style,
    })),
    openings: doors.map((d) => ({ id: d.id, wallId: d.wallId, at: d.at, widthPt: d.widthPt, kind: 'door', hinge: d.hinge })),
    doors: doors.map((d) => ({ id: d.id, wallId: d.wallId, at: d.at, widthPt: d.widthPt })),
    grids: grids.map((g) => ({ id: g.id, label: g.label, line: g.line })),
    labels: labels.map((l) => ({ text: l.text, at: l.at })),
    rooms,
    furniture: furniture.map((fu) => ({ id: fu.id, kind: fu.kind, shape: fu.shape, bbox: fu.bbox })),
    distractors: { dimensions: dims, hatches: [{ bbox: shaft }], titleBlock: { x: 965, y: 30, w: 201, h: 782 } },
  }

  // wall solid segments (gaps removed), shared by renderers
  const segments = []
  for (const w of walls) {
    const gaps = w.gaps.slice().sort((a, b) => a[0] - b[0])
    const ivs = []
    let cur = w.ext ? -DOUBLE_GAP / 2 : 0
    for (const g of gaps) {
      ivs.push([cur, g[0]])
      cur = g[1]
    }
    ivs.push([cur, w.len + (w.ext ? DOUBLE_GAP / 2 : 0)])
    const nx = -w.u.y
    const ny = w.u.x
    const offs = w.style === 'double' ? [-DOUBLE_GAP / 2, DOUBLE_GAP / 2] : [0]
    for (const [t0, t1] of ivs) {
      if (t1 - t0 < 0.5) continue
      for (const o of offs) {
        segments.push({
          a: { x: w.p0.x + w.u.x * t0 + nx * o, y: w.p0.y + w.u.y * t0 + ny * o },
          b: { x: w.p0.x + w.u.x * t1 + nx * o, y: w.p0.y + w.u.y * t1 + ny * o },
          lw: w.style === 'double' ? 0.9 : THICK_LW,
        })
      }
    }
    if (w.style === 'double') {
      for (const g of gaps) {
        for (const t of g) {
          segments.push({
            a: { x: w.p0.x + w.u.x * t - nx * DOUBLE_GAP / 2, y: w.p0.y + w.u.y * t - ny * DOUBLE_GAP / 2 },
            b: { x: w.p0.x + w.u.x * t + nx * DOUBLE_GAP / 2, y: w.p0.y + w.u.y * t + ny * DOUBLE_GAP / 2 },
            lw: 0.6,
          })
        }
      }
    }
  }

  const arcPoints = (d) => {
    const n = 16
    const out = []
    for (let i = 0; i <= n; i++) {
      const a = d._arc.a0 + (d._arc.da * i) / n
      out.push({ x: d._arc.cx + d._arc.r * Math.cos(a), y: d._arc.cy + d._arc.r * Math.sin(a) })
    }
    return out
  }

  const draw = (c) => {
    c.solid()
    // structural grids (light dash-dot) + bubbles
    c.stroke(0.55)
    c.lw(0.35)
    c.dash([14, 3, 2, 3])
    for (const g of grids) c.line(g.line[0].x, g.line[0].y, g.line[1].x, g.line[1].y)
    c.solid()
    c.stroke(0.3)
    c.lw(0.6)
    for (const g of grids) {
      c.circle(g.bubble.x, g.bubble.y, 11)
      c.fill(0)
      c.text(g.bubble.x, g.bubble.y + 3.5, g.label, 10)
    }
    // stairs, hatch
    c.stroke(0.2)
    for (const d of decor) {
      if (d.type === 'line') {
        c.lw(d.lw)
        c.stroke(d.g)
        c.line(d.a.x, d.a.y, d.b.x, d.b.y)
      } else if (d.type === 'rect') {
        c.lw(d.lw)
        c.stroke(d.g)
        c.rect(d.x, d.y, d.w, d.h)
      } else if (d.type === 'hatch') {
        c.raw('q')
        c.raw(`${c.X(d.x)} ${c.Y(d.y + d.h)} ${f(d.w)} ${f(d.h)} re W n`)
        c.lw(0.3)
        c.stroke(0.4)
        for (let k = -d.h; k < d.w; k += 4) c.line(d.x + k, d.y + d.h, d.x + k + d.h, d.y)
        c.raw('Q')
        c.lw(0.6)
        c.stroke(0.2)
        c.rect(d.x, d.y, d.w, d.h)
      }
    }
    // walls
    c.stroke(0)
    for (const s of segments) {
      c.lw(s.lw)
      c.line(s.a.x, s.a.y, s.b.x, s.b.y)
    }
    // door leaves + swing arcs (bezier)
    for (const d of doors) {
      c.stroke(0.1)
      c.lw(1)
      const tip = { x: d._arc.cx + d._arc.r * Math.cos(d._arc.a0), y: d._arc.cy + d._arc.r * Math.sin(d._arc.a0) }
      c.line(d._arc.cx, d._arc.cy, tip.x, tip.y)
      c.lw(0.4)
      c.arc(d._arc.cx, d._arc.cy, d._arc.r, d._arc.a0, d._arc.da)
    }
    // furniture
    c.stroke(0.15)
    c.lw(0.7)
    for (const fu of furniture) {
      if (fu.shape === 'rect') c.rect(fu.bbox.x, fu.bbox.y, fu.bbox.w, fu.bbox.h)
      else c.circle(fu.bbox.x + fu.bbox.w / 2, fu.bbox.y + fu.bbox.h / 2, fu.bbox.w / 2)
    }
    // dimensions
    c.stroke(0.35)
    c.lw(0.35)
    for (const d of dims) {
      const [a, b] = d.line
      c.line(a.x, a.y, b.x, b.y)
      for (const p of [a, b]) c.line(p.x - 3, p.y + 3, p.x + 3, p.y - 3)
      c.fill(0.2)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      if (d.vertical) c.text(mx + 4, my + 2, String(d.valueMm), 6, 'l')
      else c.text(mx, my - 3, String(d.valueMm), 6)
    }
    // room labels
    c.fill(0)
    for (const l of labels) c.text(l.at.x, l.at.y + 2.5, l.text, l.size)
    // frame + title block
    c.stroke(0)
    c.lw(1.2)
    c.rect(25, 25, 1141, 792)
    c.lw(0.8)
    c.rect(965, 30, 201, 782)
    for (const y of [120, 200, 560, 640, 700, 750]) c.line(965, y, 1166, y)
    c.fill(0)
    c.text(1065, 80, 'ACME ARCHITECTS', 13)
    c.text(1065, 100, 'FIXTURE PROJECT - OFFICE', 8)
    c.text(1065, 170, 'NORTH', 8)
    c.circle(1065, 150, 12)
    c.line(1065, 138, 1065, 162)
    c.text(1065, 590, `LEVEL ${level}`, 9)
    c.text(1065, 620, 'DRAWN BY  FIXTURES', 7)
    c.text(1065, 676, `SCALE 1:100`, 11)
    c.text(1065, 730, name.toUpperCase(), 11)
    c.text(1065, 785, number, 30)
    c.text(1065, 805, `SHEET ${pageIndex + 1} OF ${pageCount}`, 7)
  }

  const rasterDraw = (rc) => {
    for (const g of grids) rc.line(g.line[0], g.line[1], 0.4, 150)
    for (const s of segments) rc.line(s.a, s.b, Math.max(s.lw, 1.2), 25)
    for (const d of decor) {
      if (d.type === 'line') rc.line(d.a, d.b, 0.5, 120)
    }
    for (const d of doors) {
      const pts = arcPoints(d)
      const tip = { x: d._arc.cx + d._arc.r * Math.cos(d._arc.a0), y: d._arc.cy + d._arc.r * Math.sin(d._arc.a0) }
      rc.line({ x: d._arc.cx, y: d._arc.cy }, tip, 1, 40)
      for (let i = 0; i < pts.length - 1; i++) rc.line(pts[i], pts[i + 1], 0.5, 60)
    }
    for (const fu of furniture) {
      const b = fu.bbox
      if (fu.shape === 'rect') {
        const q = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]
        for (let i = 0; i < 4; i++) rc.line(q[i], q[(i + 1) % 4], 0.8, 60)
      } else {
        const cx = b.x + b.w / 2
        const cyy = b.y + b.h / 2
        let prev = { x: cx + b.w / 2, y: cyy }
        for (let i = 1; i <= 24; i++) {
          const a = (i / 24) * 2 * Math.PI
          const p = { x: cx + (b.w / 2) * Math.cos(a), y: cyy + (b.w / 2) * Math.sin(a) }
          rc.line(prev, p, 0.8, 60)
          prev = p
        }
      }
    }
    rc.rectOutline(25, 25, 1141, 792, 1.2, 20)
  }

  return { truth, draw, rasterDraw }
}

// ───────────────────────────── PDF assembly ─────────────────────────────

function vectorPdf(sheetCount, firstLevel) {
  const w = new PdfWriter()
  const catalog = w.alloc()
  const pages = w.alloc()
  const font = w.alloc()
  w.set(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids = []
  const sheets = []
  const labelNums = []
  for (let i = 0; i < sheetCount; i++) {
    const level = firstLevel + i
    const sheetNo = `A-${level}01`
    const sh = buildSheet({ pageIndex: i, level, variant: firstLevel - 1 + i, pageCount: sheetCount, sheetNo })
    const ctx = new Ctx()
    sh.draw(ctx)
    const content = w.alloc()
    w.set(content, w.stream('', Buffer.from(ctx.toString(), 'latin1')))
    const page = w.alloc()
    w.set(
      page,
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    )
    kids.push(`${page} 0 R`)
    labelNums.push(`${i} << /P (${sheetNo}) >>`)
    sheets.push(sh.truth)
  }
  w.set(pages, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${sheetCount} >>`)
  w.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R /PageLabels << /Nums [${labelNums.join(' ')}] >> >>`)
  return { pdf: w.build(catalog), sheets }
}

class Raster {
  constructor(w, h, s) {
    this.w = w
    this.h = h
    this.s = s
    this.buf = new Uint8Array(w * h).fill(246)
  }
  line(a, b, widthPt, value) {
    const s = this.s
    const x0 = a.x * s, y0 = a.y * s, x1 = b.x * s, y1 = b.y * s
    const hw = Math.max(widthPt * s, 1.5) / 2
    const minx = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1))
    const maxx = Math.min(this.w - 1, Math.ceil(Math.max(x0, x1) + hw + 1))
    const miny = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1))
    const maxy = Math.min(this.h - 1, Math.ceil(Math.max(y0, y1) + hw + 1))
    const dx = x1 - x0, dy = y1 - y0
    const l2 = dx * dx + dy * dy || 1
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        let t = ((x - x0) * dx + (y - y0) * dy) / l2
        t = Math.max(0, Math.min(1, t))
        const d = Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))
        if (d <= hw) {
          const i = y * this.w + x
          this.buf[i] = Math.min(this.buf[i], value)
        }
      }
    }
  }
  rectOutline(x, y, w, h, lw, v) {
    const q = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
    for (let i = 0; i < 4; i++) this.line(q[i], q[(i + 1) % 4], lw, v)
  }
  noise(seed) {
    const rng = mulberry32(seed)
    for (let i = 0; i < this.buf.length; i++) {
      const n = Math.round((rng() + rng() + rng() - 1.5) * 10)
      this.buf[i] = Math.max(0, Math.min(255, this.buf[i] + n))
    }
    for (let k = 0; k < 400; k++) {
      const x = Math.floor(rng() * this.w)
      const y = Math.floor(rng() * this.h)
      this.buf[y * this.w + x] = 120 + Math.floor(rng() * 80)
    }
  }
}

function scannedPdf() {
  const S = 2
  const sh = buildSheet({ pageIndex: 0, level: 2, variant: 7, pageCount: 1, sheetNo: 'A-201' })
  const r = new Raster(PAGE_W * S, PAGE_H * S, S)
  sh.rasterDraw(r)
  r.noise(4242)
  const w = new PdfWriter()
  const catalog = w.alloc()
  const pages = w.alloc()
  const img = w.alloc()
  w.set(
    img,
    w.stream(
      `/Type /XObject /Subtype /Image /Width ${r.w} /Height ${r.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
      deflateSync(Buffer.from(r.buf), { level: 9 }),
    ),
  )
  const content = w.alloc()
  w.set(content, w.stream('', Buffer.from(`q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q`, 'latin1')))
  const page = w.alloc()
  w.set(
    page,
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${content} 0 R /Resources << /XObject << /Im0 ${img} 0 R >> >> >>`,
  )
  w.set(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`)
  w.set(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
  sh.truth.raster = true
  sh.truth.note = 'Raster-only page: no vector paths or text. Truth lists the plan as drawn into the bitmap (2 px/pt).'
  return { pdf: w.build(catalog), sheets: [sh.truth] }
}

function writeTruth(name, pdfName, sheets) {
  const obj = {
    pdf: pdfName,
    pageCount: sheets.length,
    coordinateSystem: 'sheet: PDF points, origin top-left, y down',
    sheets,
  }
  writeFileSync(join(OUT, `${name}.truth.json`), JSON.stringify(obj, null, 1))
}

{
  const a = vectorPdf(6, 1)
  writeFileSync(join(OUT, 'office-6-sheets.pdf'), a.pdf)
  writeTruth('office-6-sheets', 'office-6-sheets.pdf', a.sheets)

  const b = vectorPdf(1, 2)
  writeFileSync(join(OUT, 'office-1-sheet.pdf'), b.pdf)
  writeTruth('office-1-sheet', 'office-1-sheet.pdf', b.sheets)

  const c = scannedPdf()
  writeFileSync(join(OUT, 'scanned-1-sheet.pdf'), c.pdf)
  writeTruth('scanned-1-sheet', 'scanned-1-sheet.pdf', c.sheets)

  const rng = mulberry32(99)
  const head = Buffer.from(
    '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resou',
    'latin1',
  )
  const junk = Buffer.alloc(300)
  for (let i = 0; i < junk.length; i++) junk[i] = Math.floor(rng() * 256)
  writeFileSync(join(OUT, 'corrupt.pdf'), Buffer.concat([head, junk]))
  writeFileSync(join(OUT, 'not-a-pdf.txt'), 'This is plain text, not a PDF. Used to test the loader error path.\n')
}

console.log('wrote fixtures/pdfs')
