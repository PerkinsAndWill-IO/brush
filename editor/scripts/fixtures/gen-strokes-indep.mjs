#!/usr/bin/env node
/**
 * INDEPENDENT held-out stroke corpus: fixtures/strokes-indep/<kind>/<kind>-indep-NNN.json
 * 30 per kind (150 total), ids 1-20 split "train", 21-30 "heldout", authors indep-1..indep-4.
 *
 * Written without reference to the main generator or the predictor, to probe overfitting.
 * Geometry comes from fixtures/pdfs/*.truth.json (PDF points, top-left origin, y down).
 * Zero dependencies, seeded PRNG, deterministic.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(root, 'fixtures', 'strokes-indep')
const PER_KIND = 30

// ───────────── PRNG ─────────────
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(0x1d3a5e7)
const rand = (a, b) => a + (b - a) * rng()
const randi = (a, b) => Math.floor(rand(a, b + 1))
const pick = (xs) => xs[Math.floor(rng() * xs.length)]
const chance = (p) => rng() < p
const sgn = () => (rng() < 0.5 ? -1 : 1)
const gauss = () => {
  let u = 0
  for (let i = 0; i < 6; i++) u += rng()
  return (u - 3) / 0.7071
}

// ───────────── truth ─────────────
const truthCache = {}
function sheetOf(pdf, i) {
  truthCache[pdf] ??= JSON.parse(readFileSync(join(root, 'fixtures', 'pdfs', `${pdf}.truth.json`), 'utf8'))
  return truthCache[pdf].sheets[i]
}
function pickSheet() {
  const r = rng()
  if (r < 0.7) return { pdf: 'office-6-sheets.pdf', sheet: randi(0, 5), t: null }
  if (r < 0.85) return { pdf: 'office-1-sheet.pdf', sheet: 0, t: null }
  return { pdf: 'scanned-1-sheet.pdf', sheet: 0, t: null }
}
function loadPick() {
  const s = pickSheet()
  s.t = sheetOf(s.pdf.replace('.pdf', ''), s.sheet)
  return s
}

// ───────────── vector helpers ─────────────
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
const mul = (a, k) => ({ x: a.x * k, y: a.y * k })
const len = (a) => Math.hypot(a.x, a.y)
const unit = (a) => {
  const l = len(a) || 1
  return { x: a.x / l, y: a.y / l }
}
const rot = (a, th) => ({ x: a.x * Math.cos(th) - a.y * Math.sin(th), y: a.x * Math.sin(th) + a.y * Math.cos(th) })
const lerp = (a, b, u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
const P = (x, y) => ({ x, y })

function densify(poly, step = 2) {
  const out = [poly[0]]
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]
    const b = poly[i]
    const n = Math.max(1, Math.ceil(len(sub(b, a)) / step))
    for (let k = 1; k <= n; k++) out.push(lerp(a, b, k / n))
  }
  return out
}
function chaikin(poly, iters = 1, closed = false) {
  let p = poly
  for (let it = 0; it < iters; it++) {
    const q = [p[0]]
    for (let i = 0; i < p.length - 1; i++) {
      q.push(lerp(p[i], p[i + 1], 0.25), lerp(p[i], p[i + 1], 0.75))
    }
    if (closed) q.push(lerp(p[p.length - 1], p[0], 0.25), lerp(p[p.length - 1], p[0], 0.75))
    else q.push(p[p.length - 1])
    p = q
  }
  return p
}
function arcPts(c, r, a0, a1, n = 24) {
  const out = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push(P(c.x + r * Math.cos(a), c.y + r * Math.sin(a)))
  }
  return out
}
function bow(poly, amount) {
  const d = densify(poly, 3)
  const n = unit(rot(sub(d[d.length - 1], d[0]), Math.PI / 2))
  return d.map((p, i) => add(p, mul(n, amount * Math.sin((Math.PI * i) / (d.length - 1)))))
}
function wobble(poly, amp, wavelen) {
  const d = densify(poly, 3)
  const ph1 = rand(0, 6.28)
  const ph2 = rand(0, 6.28)
  const out = []
  let s = 0
  for (let i = 0; i < d.length; i++) {
    if (i) s += len(sub(d[i], d[i - 1]))
    const j = i === 0 ? 1 : i
    const dir = unit(sub(d[Math.min(d.length - 1, j)], d[Math.max(0, j - 1)]))
    const n = P(-dir.y, dir.x)
    const o = amp * (0.7 * Math.sin((s / wavelen) * 6.28 + ph1) + 0.3 * Math.sin((s / (wavelen * 0.37)) * 6.28 + ph2))
    out.push(add(d[i], mul(n, o)))
  }
  return out
}
function jitterVerts(poly, a) {
  return poly.map((p) => P(p.x + gauss() * a, p.y + gauss() * a))
}

// ───────────── sampling into timed points ─────────────
const AUTHORS = {
  'indep-1': { hz: [120, 144], pressure: true, speed: [0.5, 1.6] },
  'indep-2': { hz: [60, 90], pressure: false, speed: [0.25, 1.0] },
  'indep-3': { hz: [240, 120], pressure: true, speed: [0.9, 2.6] },
  'indep-4': { hz: [90, 60, 144], pressure: false, speed: [0.4, 2.2] },
}

function sample(poly, author, opts = {}) {
  const A = AUTHORS[author]
  const d = densify(poly, 2)
  const S = [0]
  for (let i = 1; i < d.length; i++) S.push(S[i - 1] + len(sub(d[i], d[i - 1])))
  const L = S[S.length - 1]
  // corner slowdowns
  const turn = d.map((_, i) => {
    if (i < 3 || i > d.length - 4) return 0
    const a = sub(d[i], d[i - 3])
    const b = sub(d[i + 3], d[i])
    if (len(a) < 1e-6 || len(b) < 1e-6) return 0
    return Math.abs(Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y))
  })
  const hz = pick(A.hz)
  const dt0 = 1000 / hz
  let base = rand(A.speed[0], A.speed[1]) * (opts.speedMul ?? 1)
  base = Math.min(base, L / (9 * dt0))
  const out = []
  const ph = rand(0, 6.28)
  const tremAmp = rand(0.1, opts.tremor ?? 0.7)
  let t = 0
  let s = 0
  let idx = 0
  const emit = (s2, tt) => {
    while (idx < S.length - 2 && S[idx + 1] < s2) idx++
    const seg = S[idx + 1] - S[idx] || 1
    const u = Math.min(1, Math.max(0, (s2 - S[idx]) / seg))
    const p = lerp(d[idx], d[Math.min(d.length - 1, idx + 1)], u)
    const dir = unit(sub(d[Math.min(d.length - 1, idx + 1)], d[idx]))
    const tr = tremAmp * Math.sin(tt / 37 + ph) + gauss() * 0.12
    const q = { x: p.x - dir.y * tr, y: p.y + dir.x * tr }
    const frac = L ? s2 / L : 0
    const pt = { x: +q.x.toFixed(2), y: +q.y.toFixed(2), t: +tt.toFixed(1) }
    if (A.pressure) pt.p = +Math.min(1, Math.max(0.05, 0.2 + 0.55 * Math.pow(Math.sin(Math.PI * frac), 0.5) + gauss() * 0.03)).toFixed(3)
    out.push(pt)
  }
  emit(0, 0)
  let guard = 0
  while (s < L && guard++ < 20000) {
    const dt = dt0 * (1 + 0.08 * gauss())
    const frac = s / L
    const bell = opts.flat ? 0.85 : 0.25 + 0.75 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, frac))), 0.7)
    const cf = 1 - 0.65 * Math.min(1, turn[Math.min(turn.length - 1, Math.round(s / (L / (d.length - 1 || 1))))] / 1.3)
    let v = base * bell * Math.max(0.15, cf) * (0.9 + 0.2 * rng())
    if (opts.tail && frac > 0.85) v *= 1.4
    if (opts.hesitate && frac > opts.hesitate && frac < opts.hesitate + 0.05) v *= 0.2
    v = Math.max(v, 0.03)
    s += v * dt
    t += dt
    emit(Math.min(s, L), t)
  }
  return out
}

// ───────────── recording builders ─────────────
const kinds = ['wall', 'door', 'furniture', 'delete', 'markup']
const expectedOp = { wall: 'create_wall', door: 'place_door', furniture: 'place_instance', delete: 'delete', markup: null }
const clampTo = (poly, sz) => poly.map((p) => P(Math.min(sz.w - 2, Math.max(2, p.x)), Math.min(sz.h - 2, Math.max(2, p.y))))
const wlen = (w) => len(sub(w.centerline[1], w.centerline[0]))

function mkWall(i) {
  const s = loadPick()
  const T = s.t
  const v = i % 6
  let poly
  let note
  let opt = {}
  const longWalls = T.walls.filter((w) => wlen(w) > 90)
  if (v === 0 || v === 3) {
    const w = pick(longWalls)
    let a = w.centerline[0]
    let b = w.centerline[1]
    const dir = unit(sub(b, a))
    if (chance(0.5)) [a, b] = [b, a]
    const e0 = chance(0.7) ? sgn() * rand(5, 15) : 0
    const e1 = chance(0.7) ? sgn() * rand(5, 15) : 0
    const d2 = unit(sub(b, a))
    const a2 = sub(a, mul(d2, e0))
    const b2 = add(b, mul(d2, e1))
    poly = wobble([a2, b2], rand(0.5, 2.5), rand(60, 160))
    note = `${w.id} traced ${e0 || e1 ? 'with ' + (e0 + e1 > 0 ? 'overshoot' : 'short stop') : 'cleanly'}`
    void dir
    if (v === 3) {
      const last = poly[poly.length - 1]
      const tailDir = unit(sub(last, poly[poly.length - 8]))
      poly = poly.concat([add(last, mul(rot(tailDir, sgn() * rand(0.1, 0.5)), rand(8, 22)))])
      opt = { tail: true, speedMul: 1.8, flat: true }
      note = `${w.id} drawn fast with a flick tail`
    }
  } else if (v === 1) {
    const room = pick(T.rooms.filter((r) => r.polygon.length === 4))
    const k = randi(0, 3)
    const n = chance(0.5) ? 3 : 4
    const pts = []
    for (let j = 0; j < n; j++) pts.push(room.polygon[(k + j) % 4])
    poly = jitterVerts(pts, 2.5)
    if (chance(0.5)) poly = chaikin(poly, 1).map((p, ii, arr) => (ii === 0 || ii === arr.length - 1 ? p : p))
    poly = densify(poly, 3)
    note = `polyline tracing ${n - 1} connected walls around ${room.label}`
    opt = { hesitate: chance(0.4) ? 0.45 : undefined }
  } else if (v === 2) {
    const w = pick(longWalls)
    const [a, b] = chance(0.5) ? w.centerline : [w.centerline[1], w.centerline[0]]
    poly = bow([a, b], sgn() * rand(4, 14))
    poly = wobble(poly, rand(0.8, 2), rand(40, 90))
    note = `${w.id} drawn as a bowed, wobbly long wall`
  } else if (v === 4) {
    const g = pick(T.grids)
    let [a, b] = g.line
    const l = len(sub(b, a))
    const span = Math.min(l - 20, rand(100, 320))
    const dir = unit(sub(b, a))
    const off = rand(80, l - span - 40)
    a = add(a, mul(dir, off))
    b = add(a, mul(dir, span))
    const sh = rand(-4, 4)
    const nrm = P(-dir.y, dir.x)
    poly = wobble([add(a, mul(nrm, sh)), add(b, mul(nrm, sh))], rand(0.5, 1.8), rand(50, 120))
    if (chance(0.5)) poly.reverse()
    note = `wall across open space along grid ${g.label}`
  } else {
    const room = pick(T.rooms.filter((r) => r.polygon.length === 4))
    const xs = room.polygon.map((p) => p.x)
    const ys = room.polygon.map((p) => p.y)
    const cx = rand(Math.min(...xs) + 30, Math.max(...xs) - 30)
    const cy = rand(Math.min(...ys) + 30, Math.max(...ys) - 30)
    const ang = sgn() * rand(0.45, 1.1)
    const l = rand(60, 150)
    const dir = P(Math.cos(ang), Math.sin(ang))
    poly = wobble([sub(P(cx, cy), mul(dir, l / 2)), add(P(cx, cy), mul(dir, l / 2))], rand(0.4, 1.5), rand(40, 100))
    note = `diagonal wall inside ${room.label}`
  }
  return { s, poly: clampTo(poly, T.sizePt), note, opt }
}

function mkDoor(i) {
  const s = loadPick()
  const T = s.t
  const op = pick(T.openings)
  const wall = T.walls.find((w) => w.id === op.wallId) ?? T.walls[0]
  const d = unit(sub(wall.centerline[1], wall.centerline[0]))
  const n = P(-d.y, d.x)
  const ppm = T.ptPerMeter
  const w = ppm * rand(0.7, 1.2)
  const c = add(op.at, mul(d, rand(-4, 4)))
  const v = i % 6
  let poly
  let note
  let opt = {}
  const ang = sgn() * rand(0.1, 0.45)
  if (v === 0 || v === 4) {
    const h = v === 0 ? rand(10, 22) : w / 2
    const dir = rot(n, ang)
    poly = [sub(c, mul(dir, h * rand(0.7, 1.1))), add(c, mul(dir, h * rand(0.7, 1.1)))]
    note = v === 0 ? `short tick across ${wall.id}, ${(ang * 57).toFixed(0)} deg off normal` : `door-width (${(w / ppm).toFixed(2)} m) slash through ${wall.id}`
    poly = densify(poly, 2)
    if (chance(0.5)) poly.reverse()
    opt = { speedMul: 0.8 }
  } else if (v === 1) {
    const dir = rot(n, ang)
    const h = rand(10, 20)
    const a = sub(c, mul(dir, h))
    const b = add(c, mul(dir, h))
    const sh = mul(d, rand(1, 3))
    poly = densify([a, b, add(a, sh), add(b, mul(sh, 2)), add(a, mul(sh, 2))].slice(0, chance(0.5) ? 5 : 3), 2)
    note = `door tick drawn back and forth across ${wall.id}`
    opt = { speedMul: 1.3 }
  } else if (v === 2 || v === 3) {
    const sd = sgn()
    const sw = sgn()
    const H = sub(c, mul(d, sd * w / 2))
    const E = add(H, mul(d, sd * w))
    const T0 = add(H, mul(n, sw * w))
    const a0 = Math.atan2(T0.y - H.y, T0.x - H.x)
    const a1 = Math.atan2(E.y - H.y, E.x - H.x)
    let da = a1 - a0
    while (da > Math.PI) da -= 2 * Math.PI
    while (da < -Math.PI) da += 2 * Math.PI
    const arc = arcPts(H, w * rand(0.95, 1.05), a0, a0 + da, 22)
    if (v === 2) {
      // leaf from hinge, then arc to wall (or reverse)
      poly = chance(0.5) ? [H, ...arc] : [...arc.slice().reverse(), H]
      note = `quarter-arc door with leaf, ${(w / ppm).toFixed(2)} m, beside ${wall.id}`
    } else {
      poly = chance(0.5) ? arc : arc.slice().reverse()
      note = `quarter arc only (swing) for a ${(w / ppm).toFixed(2)} m door at ${wall.id}`
    }
    poly = wobble(poly, 0.5, 40)
  } else {
    const dir = rot(n, ang * 1.6)
    const h = rand(12, 18)
    poly = densify([sub(c, mul(dir, h)), add(c, mul(dir, h))], 2)
    poly = poly.concat(densify([add(c, mul(dir, h)), add(c, mul(dir, h * 0.2 + 2))], 2))
    note = `tick over ${wall.id} with a small retrace`
  }
  void opt
  return { s, poly: clampTo(poly, T.sizePt), note, opt: v === 1 ? { speedMul: 1.3 } : {} }
}

function furnitureRect(cx, cy, w, h, rotA) {
  const hw = w / 2
  const hh = h / 2
  return [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)].map((p) => add(rot(p, rotA), P(cx, cy)))
}
function mkFurniture(i) {
  const s = loadPick()
  const T = s.t
  const v = i % 6
  let item = pick(T.furniture)
  let cx = item.bbox.x + item.bbox.w / 2
  let cy = item.bbox.y + item.bbox.h / 2
  let w = item.bbox.w * rand(0.85, 1.4)
  let h = item.bbox.h * rand(0.85, 1.4)
  if (chance(0.35)) {
    const room = pick(T.rooms.filter((r) => r.polygon.length === 4))
    const xs = room.polygon.map((p) => p.x)
    const ys = room.polygon.map((p) => p.y)
    cx = rand(Math.min(...xs) + 30, Math.max(...xs) - 30)
    cy = rand(Math.min(...ys) + 30, Math.max(...ys) - 30)
    w = rand(22, 75)
    h = rand(16, 45)
  }
  w = Math.max(w, 16)
  h = Math.max(h, 14)
  const tilt = rand(-0.08, 0.08)
  let poly
  let note
  const opt = {}
  if (v === 0) {
    const r = furnitureRect(cx, cy, w, h, tilt)
    poly = chaikin(densify([...r, r[0]], 3), 2)
    poly = poly.slice(0, poly.length)
    note = `${item.kind} as a rectangle with rounded corners`
  } else if (v === 1) {
    const r = furnitureRect(cx, cy, w, h, tilt)
    const ov = rand(0.08, 0.2)
    poly = [lerp(r[0], r[3], 0.1), r[0], r[1], r[2], r[3], add(r[0], mul(sub(r[0], r[3]), -0.08)), add(r[0], mul(unit(sub(r[1], r[0])), ov * w))]
    poly = jitterVerts(poly, 1.2)
    note = `${item.kind} rectangle, corners overshoot and the stroke overlaps its start`
  } else if (v === 2) {
    const r = furnitureRect(cx, cy, w, h, tilt)
    const open = rand(0.25, 0.6)
    poly = [r[1], r[0], r[3], r[2], lerp(r[2], r[1], 1 - open)]
    poly = jitterVerts(poly, 1)
    note = `${item.kind} as an open (unclosed) rectangle`
    if (chance(0.5)) poly.reverse()
  } else if (v === 3) {
    const rx = w / 2
    const ry = chance(0.5) ? w / 2 : h / 2
    const a0 = rand(0, 6.28)
    const turns = rand(1.04, 1.2)
    poly = []
    const N = 60
    for (let k = 0; k <= N; k++) {
      const a = a0 + (turns * 6.2832 * k) / N
      const grow = 1 + 0.06 * (k / N)
      poly.push(P(cx + rx * grow * Math.cos(a), cy + ry * grow * Math.sin(a)))
    }
    note = ry === rx ? 'round table, circle drawn in one go' : 'oval table'
  } else if (v === 4) {
    const a = Math.max(w, 40)
    const b = Math.max(h, 24)
    const t1 = rand(0.35, 0.5) * b
    const t2 = rand(0.35, 0.5) * a
    const pts = [P(0, 0), P(a, 0), P(a, t1), P(t2, t1), P(t2, b), P(0, b), P(0, 0)].map((p) => add(rot(sub(p, P(a / 2, b / 2)), tilt), P(cx, cy)))
    poly = densify(chaikin(jitterVerts(pts, 0.8), 1), 3)
    note = 'L-shaped desk'
  } else {
    const ww = Math.min(w, 40)
    const hh = Math.min(h, 28)
    const r = furnitureRect(cx, cy, ww, hh, tilt)
    const r2 = furnitureRect(cx + gauss() * 1.5, cy + gauss() * 1.5, ww * rand(0.95, 1.05), hh * rand(0.95, 1.05), tilt)
    poly = [...r, r[0], ...r2, r2[0]]
    poly = chaikin(densify(jitterVerts(poly, 0.8), 3), 1)
    note = `small ${item.kind} rectangle drawn twice over`
    opt.speedMul = 1.2
  }
  return { s, poly: clampTo(poly, T.sizePt), note, opt }
}

function zigzagIn(c, wd, ht, ang, n) {
  const pts = []
  for (let k = 0; k <= n; k++) {
    const x = -wd / 2 + (wd * k) / n
    const y = (k % 2 ? -1 : 1) * (ht / 2) * rand(0.7, 1.1)
    pts.push(add(rot(P(x, y), ang), c))
  }
  return pts
}
function mkDelete(i) {
  const s = loadPick()
  const T = s.t
  const v = i % 4
  const eraser = i % 4 === 3 || (i % 8 === 6 && false)
  const onWall = chance(0.4)
  let c
  let wd
  let ht
  let ang
  let target
  if (onWall) {
    const w = pick(T.walls.filter((q) => wlen(q) > 70))
    const a = w.centerline[0]
    const b = w.centerline[1]
    const l = wlen(w)
    const span = Math.min(l * 0.8, rand(45, 130))
    const u = rand(span / 2 / l, 1 - span / 2 / l)
    c = lerp(a, b, u)
    wd = span
    ht = rand(14, 30)
    ang = Math.atan2(b.y - a.y, b.x - a.x)
    target = w.id
  } else {
    const f = pick(T.furniture)
    c = P(f.bbox.x + f.bbox.w / 2, f.bbox.y + f.bbox.h / 2)
    wd = Math.max(26, f.bbox.w * rand(1.0, 1.7))
    ht = Math.max(22, f.bbox.h * rand(1.0, 1.7))
    ang = rand(-0.3, 0.3)
    target = f.id
  }
  let poly
  let note
  const opt = {}
  if (eraser) {
    const n = randi(3, 5)
    poly = []
    for (let k = 0; k <= n * 6; k++) {
      const u = (k % (n * 2)) / n
      const x = (u <= 1 ? u : 2 - u) * wd - wd / 2
      poly.push(add(rot(P(x, ht * 0.18 * Math.sin(k * 0.9) + gauss() * 1.5), ang), c))
    }
    poly = chaikin(poly, 1)
    note = `eraser rubbing back and forth over ${target}`
  } else if (v === 0) {
    poly = chaikin(zigzagIn(c, wd, ht, ang, randi(5, 11)), chance(0.5) ? 1 : 0)
    note = `zigzag scribble over ${target}`
    opt.speedMul = 1.6
  } else if (v === 1) {
    const k = randi(4, 7)
    const r = Math.max(ht, 18) * 0.55
    poly = []
    const N = k * 14
    for (let q = 0; q <= N; q++) {
      const th = (q / N) * k * 2 * Math.PI
      const x = -wd / 2 + (wd * q) / N + r * Math.cos(th) * 0.9
      const y = r * Math.sin(th) * rand(0.9, 1.1)
      poly.push(add(rot(P(x, y), ang), c))
    }
    note = `looping scribble over ${target}`
    opt.speedMul = 1.5
  } else if (v === 2) {
    const a = zigzagIn(c, wd, ht, ang + 0.6, randi(5, 8))
    const b = zigzagIn(c, wd, ht, ang - 0.7, randi(5, 8))
    poly = [...a, ...b]
    note = `cross-hatching scribble over ${target}`
    opt.speedMul = 1.7
  } else {
    const hw = wd * 0.6
    const hh = ht * 0.8
    const pts = [P(-hw, -hh), P(hw, hh), P(hw, -hh), P(-hw, hh)].map((p) => add(rot(p, ang * 0.3), c))
    poly = densify(jitterVerts(pts, 2), 2)
    note = `X mark in one stroke over ${target}`
    opt.speedMul = 1.4
  }
  return { s, poly: clampTo(wobble(poly, 0.8, 20), T.sizePt), note: `${note}; target:${target}`, tool: eraser ? 'eraser' : 'brush', opt }
}

function anchors(T) {
  const out = []
  for (const l of T.labels) out.push({ kind: 'label', p: l.at, text: l.text })
  for (const o of T.openings) out.push({ kind: 'door', p: o.at })
  for (const f of T.furniture) out.push({ kind: 'furn', p: P(f.bbox.x + f.bbox.w / 2, f.bbox.y + f.bbox.h / 2), box: f.bbox })
  for (const w of T.walls) out.push({ kind: 'wall', p: lerp(w.centerline[0], w.centerline[1], rand(0.2, 0.8)), w })
  return out
}
function mkMarkup(i) {
  const s = loadPick()
  const T = s.t
  const v = i % 8
  const an = anchors(T)
  const near = (kinds) => pick(an.filter((a) => kinds.includes(a.kind)))
  let poly
  let note
  const opt = {}
  if (v === 0) {
    const a = near(['label', 'wall', 'furn'])
    const chars = randi(4, 9)
    const wd = chars * rand(7, 10)
    const x0 = a.p.x + rand(-wd / 2, 10)
    const y0 = a.p.y + rand(8, 22) * sgn()
    const T2 = chars * 2 * Math.PI * 0.8
    const r = rand(5, 8)
    const ph = rand(0, 6)
    poly = []
    const N = Math.round(chars * 22)
    for (let q = 0; q <= N; q++) {
      const th = (q / N) * T2
      const amp = r * (0.5 + 0.5 * Math.abs(Math.sin(0.4 * th + ph)))
      poly.push(P(x0 + (wd * q) / N - amp * Math.sin(th) * 0.9, y0 + amp * Math.cos(th) * 1.1))
    }
    note = `cursive handwritten word (~${chars} letters) near ${a.kind}`
    opt.speedMul = 1.1
  } else if (v === 1) {
    const a = near(['wall', 'furn', 'door'])
    const ang = rand(0, 6.28)
    const l = rand(35, 90)
    const tip = add(a.p, mul(P(Math.cos(ang), Math.sin(ang)), rand(2, 10)))
    const tail = add(tip, mul(P(Math.cos(ang + Math.PI), Math.sin(ang + Math.PI)), l))
    const shaft = bow([tail, tip], sgn() * rand(0, 6))
    const dir = unit(sub(tip, tail))
    const hl = rand(8, 13)
    const b1 = add(tip, mul(rot(dir, Math.PI - 0.5), hl))
    const b2 = add(tip, mul(rot(dir, Math.PI + 0.5), hl))
    poly = [...shaft, b1, tip, b2]
    note = `arrow with open head pointing at ${a.kind}`
  } else if (v === 2) {
    const a = near(['wall'])
    const w = a.w
    const d = unit(sub(w.centerline[1], w.centerline[0]))
    const n = P(-d.y, d.x)
    const off = sgn() * rand(14, 30)
    const l = wlen(w)
    const span = Math.min(l * 0.85, rand(60, 240))
    const u0 = rand(0, (l - span) / l)
    const A = add(lerp(w.centerline[0], w.centerline[1], u0), mul(n, off))
    const B = add(A, mul(d, span))
    const tk = mul(chance(0.5) ? rot(n, 0.7) : n, rand(5, 8))
    poly = densify([add(A, tk), sub(A, tk), A, B, add(B, tk), sub(B, tk)], 2)
    note = `dimension-like line with end ticks parallel to ${w.id}`
  } else if (v === 3) {
    const a = near(['furn', 'label', 'door'])
    const cw = rand(60, 120)
    const ch = rand(40, 75)
    const x0 = a.p.x - cw / 2
    const y0 = a.p.y - ch / 2
    const corners = [P(x0, y0), P(x0 + cw, y0), P(x0 + cw, y0 + ch), P(x0, y0 + ch), P(x0, y0)]
    poly = []
    for (let e = 0; e < 4; e++) {
      const A = corners[e]
      const B = corners[e + 1]
      const L = len(sub(B, A))
      const nb = Math.max(3, Math.round(L / 14))
      const dir = unit(sub(B, A))
      const outward = rot(dir, -Math.PI / 2)
      for (let k = 0; k < nb; k++) {
        const s0 = add(A, mul(dir, (L * k) / nb))
        const cc = add(s0, mul(dir, L / nb / 2))
        const r = L / nb / 2
        const base = Math.atan2(-dir.y, -dir.x)
        const bump = arcPts(cc, r, base, base + Math.PI * (Math.atan2(outward.y, outward.x) - base < 0 ? -1 : 1) * -1, 8)
        void bump
        const a0 = Math.atan2(dir.y, dir.x) + Math.PI
        for (let q = 0; q <= 8; q++) {
          const th = a0 + (Math.PI * q) / 8
          const pt = P(cc.x + r * Math.cos(th), cc.y + r * Math.sin(th))
          // keep bulge on outward side
          const rel = sub(pt, cc)
          const flip = rel.x * outward.x + rel.y * outward.y < 0
          poly.push(flip ? P(cc.x - rel.x, cc.y - rel.y) : pt)
        }
      }
    }
    note = `revision cloud around ${a.kind}`
    opt.speedMul = 1.2
  } else if (v === 4) {
    const a = near(['label'])
    const rx = (a.text.length * 3.6 + 12) * rand(1, 1.3)
    const ry = rand(11, 18)
    const a0 = rand(0, 6.28)
    const turns = rand(1.05, 1.25)
    poly = []
    for (let k = 0; k <= 50; k++) {
      const an2 = a0 + (turns * 6.2832 * k) / 50
      const gr = 1 + 0.08 * (k / 50)
      poly.push(P(a.p.x + rx * gr * Math.cos(an2), a.p.y + ry * gr * Math.sin(an2)))
    }
    note = `circling room label "${a.text}"`
  } else if (v === 5) {
    const a = near(['door', 'furn', 'wall', 'label'])
    const sz = rand(0.8, 1.5)
    const o = add(a.p, P(rand(-12, 12), rand(-12, 12)))
    poly = densify([o, add(o, P(7 * sz, 8 * sz)), add(o, P(24 * sz, -12 * sz))], 2)
    poly = wobble(poly, 0.5, 20)
    note = `check mark near ${a.kind}`
  } else if (v === 6) {
    const a = near(['label'])
    const wd = a.text.length * 4.2 * rand(0.9, 1.3)
    const A = P(a.p.x - wd / 2 + rand(-4, 4), a.p.y + rand(8, 14))
    const B = add(A, P(wd, rand(-2, 2)))
    poly = wobble([A, B], rand(0.4, 1.5), 40)
    if (chance(0.4)) poly.push(add(B, P(rand(4, 9), rand(-8, -3))))
    note = `underline beneath "${a.text}"`
  } else {
    const a = near(['label', 'furn', 'wall'])
    const r = rand(5, 9)
    const c = add(a.p, P(rand(-10, 20), rand(-20, -8)))
    const arc = arcPts(c, r, Math.PI * 1.05, Math.PI * 2.0 + Math.PI * 0.55, 18)
    const last = arc[arc.length - 1]
    poly = [...arc, add(last, P(-r * 0.7, r * 1.1)), add(last, P(-r * 0.7, r * 2.1))]
    note = `question mark next to ${a.kind}`
    opt.speedMul = 0.9
  }
  return { s, poly: clampTo(poly, T.sizePt), note, opt }
}

const builders = { wall: mkWall, door: mkDoor, furniture: mkFurniture, delete: mkDelete, markup: mkMarkup }

// ───────────── write ─────────────
rmSync(OUT, { recursive: true, force: true })
const index = []
for (const kind of kinds) {
  mkdirSync(join(OUT, kind), { recursive: true })
  for (let i = 0; i < PER_KIND; i++) {
    const b = builders[kind](i)
    const author = `indep-${((i + kinds.indexOf(kind)) % 4) + 1}`
    const points = sample(b.poly, author, b.opt)
    const id = `${kind}-indep-${String(i + 1).padStart(3, '0')}`
    const rec = {
      pdf: b.s.pdf,
      sheet: b.s.sheet,
      label: { kind, note: b.note },
      points,
      tool: b.tool ?? 'brush',
      author,
      expectedOp: expectedOp[kind],
      split: i + 1 > 20 ? 'heldout' : 'train', // ids 1-20 tune, 21-30 held out
    }
    writeFileSync(join(OUT, kind, `${id}.json`), JSON.stringify(rec))
    index.push({ id, kind, author, pdf: rec.pdf, sheet: rec.sheet, points: points.length, durationMs: points[points.length - 1].t, note: b.note })
  }
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1))
console.log(`wrote ${index.length} recordings to ${OUT}`)
