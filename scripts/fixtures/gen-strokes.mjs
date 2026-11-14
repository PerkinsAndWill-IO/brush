#!/usr/bin/env node
// Deterministic synthetic stroke corpus generator.
//
//   node scripts/fixtures/gen-strokes.mjs        (run gen-pdfs.mjs first)
//
// Reads fixtures/pdfs/*.truth.json and writes fixtures/strokes/<kind>/<id>.json
// as StrokeRecording (see src/core/types). Points are in sheet coordinates
// (PDF pts, top-left origin, y down), t in ms from 0 at ~120 Hz.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PDFS = join(ROOT, 'fixtures', 'pdfs')
const OUT = join(ROOT, 'fixtures', 'strokes')

const PER_KIND = 50
const KINDS = ['wall', 'door', 'furniture', 'delete', 'markup']
const OPS = { wall: 'create_wall', door: 'place_door', furniture: 'place_instance', delete: 'delete', markup: null }
const SHEET_W = 1191
const SHEET_H = 842
const M = 28.3465

// ───────────────────────────── math / rng ─────────────────────────────

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hashStr = (s) => {
  let h = 2166136261
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return h >>> 0
}
const U = (rng, a, b) => a + (b - a) * rng()
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const sgn = (rng) => (rng() < 0.5 ? -1 : 1)
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
const mul = (a, k) => ({ x: a.x * k, y: a.y * k })
const len = (a) => Math.hypot(a.x, a.y)
const norm = (a) => {
  const l = len(a) || 1
  return { x: a.x / l, y: a.y / l }
}
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
const rot = (v, a) => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) })
const perp = (v) => ({ x: -v.y, y: v.x })
const smooth = (x) => {
  const t = Math.max(0, Math.min(1, x))
  return t * t * (3 - 2 * t)
}

// ───────────────────────────── authors ─────────────────────────────

const AUTHORS = {
  'synth-a': { speed: 320, jitter: 0.5, tidiness: 0.9, base: 0.6 },
  'synth-b': { speed: 190, jitter: 1.3, tidiness: 0.55, base: 0.5 },
  'synth-c': { speed: 520, jitter: 0.8, tidiness: 0.25, base: 0.7 },
}
const AUTHOR_NAMES = Object.keys(AUTHORS)

// ───────────────────────────── pen simulation ─────────────────────────────

function densify(poly, step = 1) {
  const out = [poly[0]]
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]
    const b = poly[i]
    const d = len(sub(b, a))
    const n = Math.max(1, Math.round(d / step))
    for (let k = 1; k <= n; k++) out.push(lerp(a, b, k / n))
  }
  return out
}

/**
 * Turn an ideal polyline into a pen trace.
 * opts: open (bool, apply bow/overshoot/hook), speedMul, minMs, profile ('stroke'|'scribble')
 */
function simulate(poly, au, rng, opts = {}) {
  const { open = true, speedMul = 1, profile = 'stroke' } = opts
  let pts = densify(poly, 1)
  const tid = au.tidiness

  if (open) {
    // overshoot along end tangent
    const n = pts.length
    const tan = norm(sub(pts[n - 1], pts[Math.max(0, n - 6)]))
    const ov = (1 - tid) * rng() * 5
    for (let k = 1; k <= Math.round(ov); k++) pts.push(add(pts[n - 1], mul(tan, k)))
    // bow (low-frequency sideways drift)
    const L = pts.length
    const nrm = perp(norm(sub(pts[L - 1], pts[0])))
    const bow = (1 - tid) * L * 0.02 * (rng() * 2 - 1)
    pts = pts.map((p, i) => add(p, mul(nrm, bow * Math.sin((Math.PI * i) / (L - 1)))))
    // hook at the end
    const hook = (1 - tid) * 3 * rng() * sgn(rng)
    const hn = perp(tan)
    const hl = Math.min(8, L)
    for (let i = L - hl; i < L; i++) pts[i] = add(pts[i], mul(hn, hook * smooth((i - (L - hl)) / hl)))
  }

  // arc-length parametrisation
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])))
  const total = cum[cum.length - 1] || 1

  // corner positions (sharp direction changes) cause slow-downs
  const corners = []
  for (let i = 4; i < pts.length - 4; i += 2) {
    const a = norm(sub(pts[i], pts[i - 4]))
    const b = norm(sub(pts[i + 4], pts[i]))
    const ang = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)))
    if (ang > 0.9) corners.push(cum[i])
  }
  const spd = (s) => {
    const x = s / total
    const base = profile === 'scribble' ? 0.45 + 0.55 * Math.pow(Math.sin(Math.PI * x), 0.7) : 0.15 + 0.85 * Math.pow(Math.sin(Math.PI * x), 0.7)
    let m = 1
    for (const c of corners) m -= 0.5 * Math.exp(-(((s - c) / 9) ** 2))
    return Math.max(0.1, base * Math.max(0.25, m))
  }
  // integrate time over arc length
  const tt = [0]
  for (let i = 1; i < pts.length; i++) {
    const s = (cum[i] + cum[i - 1]) / 2
    tt.push(tt[i - 1] + (cum[i] - cum[i - 1]) / spd(s))
  }
  const speed = au.speed * speedMul * U(rng, 0.85, 1.2)
  // normalise so that mean speed = speed
  const raw = tt[tt.length - 1]
  const targetMs = Math.max(opts.minMs ?? 130, (total / speed) * 1000)
  const k = targetMs / raw
  const T = tt.map((x) => x * k)
  const Tend = T[T.length - 1]

  // tremor: sum of sinusoids per axis
  const tremor = () =>
    [5, 8.5, 11.5].map((f, i) => ({ f: f * U(rng, 0.9, 1.1), ph: U(rng, 0, 6.28), a: au.jitter * [0.7, 0.45, 0.3][i] }))
  const trx = tremor()
  const try_ = tremor()
  const tr = (set, t) => set.reduce((s, c) => s + c.a * Math.sin(2 * Math.PI * c.f * (t / 1000) + c.ph), 0)
  const base = au.base * U(rng, 0.85, 1.15)
  const prPh = U(rng, 0, 6.28)

  // fixed-rate sampling with jitter
  const out = []
  let t = 0
  let j = 0
  const stepMs = 1000 / 120
  while (true) {
    const tc = Math.min(t, Tend)
    while (j < T.length - 2 && T[j + 1] < tc) j++
    const f = T[j + 1] > T[j] ? (tc - T[j]) / (T[j + 1] - T[j]) : 0
    const p = lerp(pts[j], pts[j + 1], Math.max(0, Math.min(1, f)))
    const x = Math.max(0, Math.min(Tend ? 1 : 1, tc / (Tend || 1)))
    const press =
      base * (0.35 + 0.65 * smooth(x / 0.15) * smooth((1 - x) / 0.2)) + 0.03 * Math.sin(prPh + tc / 37) + (rng() - 0.5) * 0.03
    out.push({
      x: Math.max(0, Math.min(SHEET_W, +(p.x + tr(trx, tc) + (rng() - 0.5) * 0.25).toFixed(2))),
      y: Math.max(0, Math.min(SHEET_H, +(p.y + tr(try_, tc) + (rng() - 0.5) * 0.25).toFixed(2))),
      t: +tc.toFixed(1),
      p: +Math.max(0.05, Math.min(1, press)).toFixed(3),
    })
    if (t >= Tend) break
    t += stepMs * (1 + (rng() - 0.5) * 0.06)
  }
  out[0].t = 0
  return out
}

// ───────────────────────────── context ─────────────────────────────

function loadSheets() {
  const sheets = []
  for (const name of ['office-6-sheets', 'office-1-sheet']) {
    const truth = JSON.parse(readFileSync(join(PDFS, `${name}.truth.json`), 'utf8'))
    for (const s of truth.sheets) {
      const bboxOf = (poly) => {
        const xs = poly.map((p) => p.x)
        const ys = poly.map((p) => p.y)
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
      }
      sheets.push({
        pdf: truth.pdf,
        page: s.pageIndex,
        s,
        rooms: s.rooms.map((r) => ({ ...r, box: bboxOf(r.polygon) })),
        gv: s.grids.filter((g) => /[A-Z]/.test(g.label)).map((g) => g.line[0].x).sort((a, b) => a - b),
        gh: s.grids.filter((g) => /\d/.test(g.label)).map((g) => g.line[0].y).sort((a, b) => a - b),
      })
    }
  }
  return sheets
}

// ───────────────────────────── geometry generators ─────────────────────────────

function genWall(ctx, rng, amb) {
  const { s, gv, gh } = ctx
  const mode = amb ? 'short' : pick(rng, ['along', 'along', 'along', 'floor', 'floor', 'floor', 'floor', 'L', 'L'])
  if (mode === 'short' || mode === 'along') {
    const cands = s.walls.filter((w) => {
      const l = len(sub(w.centerline[1], w.centerline[0]))
      return l >= (amb ? 1.5 : 1.8) * M
    })
    const w = pick(rng, cands)
    const a = w.centerline[0]
    const b = w.centerline[1]
    const L = len(sub(b, a))
    const u = norm(sub(b, a))
    const want = amb ? U(rng, 1.05, 1.35) * M : Math.min(L, U(rng, 1.4, 9) * M)
    const t0 = rng() < 0.4 ? 0 : U(rng, 0, Math.max(0, L - want))
    const n = perp(u)
    const off = (amb ? U(rng, 0, 1.5) : U(rng, -2, 2)) * 1 + (amb && rng() < 0.5 ? sgn(rng) * U(rng, 5, 12) : 0)
    let p0 = add(add(a, mul(u, t0)), mul(n, off))
    let p1 = add(p0, mul(u, Math.min(want, L - t0)))
    if (rng() < 0.5) [p0, p1] = [p1, p0]
    return { poly: [p0, p1], note: amb ? 'ambiguous: short wall vs door-length stroke' : `wall along ${w.id}` }
  }
  if (mode === 'floor') {
    const horiz = rng() < 0.5
    if (horiz) {
      const y0 = pick(rng, gh)
      const yy = rng() < 0.5 ? y0 : y0 + U(rng, 0.2, 0.8) * (gh[Math.min(gh.length - 1, gh.indexOf(y0) + 1)] - y0)
      const i = Math.floor(rng() * (gv.length - 1))
      const k = i + 1 + Math.floor(rng() * Math.min(2, gv.length - 1 - i))
      return { poly: [{ x: gv[i], y: yy }, { x: gv[k], y: yy }], note: 'wall across floor between grids (horizontal)' }
    }
    const x0 = pick(rng, gv)
    const xx = rng() < 0.5 ? x0 : x0 + U(rng, 0.2, 0.8) * (gv[Math.min(gv.length - 1, gv.indexOf(x0) + 1)] - x0)
    const i = Math.floor(rng() * (gh.length - 1))
    const k = i + 1 + Math.floor(rng() * Math.min(1, gh.length - 1 - i))
    return { poly: [{ x: xx, y: gh[i] }, { x: xx, y: gh[k] }], note: 'wall across floor between grids (vertical)' }
  }
  // L polyline from a grid intersection
  const c = { x: pick(rng, gv.slice(0, -1)), y: pick(rng, gh.slice(0, -1)) }
  const dx = Math.min(U(rng, 2.5, 6) * M, gv[gv.length - 1] - c.x)
  const dy = Math.min(U(rng, 2.5, 6) * M, gh[gh.length - 1] - c.y)
  const A = { x: c.x + dx, y: c.y }
  const B = { x: c.x, y: c.y + dy }
  return { poly: rng() < 0.5 ? [A, c, B] : [B, c, A], note: 'L-shaped wall polyline at grid corner' }
}

function genDoor(ctx, rng, amb) {
  const { s } = ctx
  for (let attempt = 0; attempt < 60; attempt++) {
    const w = pick(rng, s.walls)
    const a = w.centerline[0]
    const b = w.centerline[1]
    const L = len(sub(b, a))
    if (L < 3.2 * M) continue
    const u = norm(sub(b, a))
    const n = perp(u)
    const t = U(rng, 1.2 * M, L - 1.2 * M)
    const c = add(a, mul(u, t))
    const clash = s.doors.some((d) => d.wallId === w.id && len(sub(d.at, c)) < 1.3 * M)
    if (clash) continue
    if (!amb && rng() < 0.4) {
      // quarter arc beside the wall
      const R = U(rng, 0.8, 1) * M
      const side = sgn(rng)
      const dir = sgn(rng)
      const a0 = Math.atan2(n.y * side, n.x * side)
      const a1 = Math.atan2(u.y * dir, u.x * dir)
      let da = a1 - a0
      while (da > Math.PI) da -= 2 * Math.PI
      while (da < -Math.PI) da += 2 * Math.PI
      const poly = []
      for (let i = 0; i <= 14; i++) {
        const an = a0 + (da * i) / 14
        poly.push({ x: c.x + R * Math.cos(an), y: c.y + R * Math.sin(an) })
      }
      if (rng() < 0.5) poly.reverse()
      return { poly, note: `door swing arc beside ${w.id}` }
    }
    const Ls = (amb ? U(rng, 1.15, 1.35) : U(rng, 0.8, 1.0)) * M
    const tilt = amb ? U(rng, 0.25, 0.45) * sgn(rng) : U(rng, -0.1, 0.1)
    const d = rot(n, tilt)
    const sh = amb ? 0 : U(rng, -0.1, 0.1) * Ls
    let p0 = add(c, mul(d, -Ls / 2 + sh))
    let p1 = add(c, mul(d, Ls / 2 + sh))
    if (rng() < 0.5) [p0, p1] = [p1, p0]
    return {
      poly: [p0, p1],
      note: amb ? `ambiguous: long tilted tick across ${w.id}, could be short wall` : `door tick crossing ${w.id}`,
    }
  }
  throw new Error('no door spot')
}

function shapeRect(rng, cx, cy, w, h, au, sloppy) {
  const ang = U(rng, -0.08, 0.08) * (1 + (1 - au.tidiness) * 2)
  const corners = [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
  ].map((p) => add({ x: cx, y: cy }, rot(p, ang)))
  const start = Math.floor(rng() * 4)
  const dirCW = rng() < 0.7
  const order = []
  for (let i = 0; i < 5; i++) order.push(corners[(dirCW ? start + i : start - i + 8) % 4])
  const rc = ((1 - au.tidiness) * 0.25 + (sloppy ? 0.2 : 0)) * Math.min(w, h)
  const poly = [order[0]]
  for (let i = 1; i < 4; i++) {
    const p = order[i]
    const din = norm(sub(p, order[i - 1]))
    const dout = norm(sub(order[i + 1], p))
    const q0 = sub(p, mul(din, rc))
    const q2 = add(p, mul(dout, rc))
    for (let k = 0; k <= 6; k++) {
      const t = k / 6
      poly.push(add(add(mul(q0, (1 - t) * (1 - t)), mul(p, 2 * t * (1 - t))), mul(q2, t * t)))
    }
  }
  const last = order[4]
  if (sloppy || rng() < 0.3) {
    // stop short -> open gap
    poly.push(lerp(order[3], last, U(rng, 0.7, 0.92)))
  } else {
    poly.push(last)
    const d = norm(sub(order[1], order[0]))
    poly.push(add(last, mul(d, U(rng, 2, 8) * (1.2 - au.tidiness))))
  }
  return poly
}

function shapeRound(rng, cx, cy, rx, ry, blob) {
  const th0 = U(rng, 0, 6.28)
  const dir = rng() < 0.7 ? 1 : -1
  const ph1 = U(rng, 0, 6.28)
  const ph2 = U(rng, 0, 6.28)
  const turns = U(rng, 1.03, 1.12)
  const poly = []
  const steps = 72
  for (let i = 0; i <= steps * turns; i++) {
    const th = (i / steps) * 2 * Math.PI
    const k = 1 + (blob ? 0.18 * Math.sin(2 * th + ph1) + 0.1 * Math.sin(3 * th + ph2) : 0) + 0.04 * (i / steps)
    poly.push({ x: cx + rx * k * Math.cos(th0 + dir * th), y: cy + ry * k * Math.sin(th0 + dir * th) })
  }
  return poly
}

function genFurniture(ctx, rng, amb, au) {
  const { s, rooms } = ctx
  const eligible = rooms.filter((r) => !/CORRIDOR|STAIR/.test(r.label))
  for (let attempt = 0; attempt < 80; attempt++) {
    const room = pick(rng, eligible)
    const shape = amb ? pick(rng, ['sloppy-rect', 'tiny-blob']) : pick(rng, ['rect', 'rect', 'circle', 'blob'])
    let w, h
    if (shape === 'rect' || shape === 'sloppy-rect') {
      w = U(rng, 0.5, 2.0) * M
      h = U(rng, 0.5, 1.2) * M
    } else if (shape === 'tiny-blob') {
      w = h = U(rng, 0.5, 0.7) * M
    } else {
      w = h = U(rng, 0.5, 1.6) * M
    }
    const mg = 0.35 * M
    const b = room.box
    if (b.x1 - b.x0 < w + 2 * mg || b.y1 - b.y0 < h + 2 * mg) continue
    const cx = U(rng, b.x0 + mg + w / 2, b.x1 - mg - w / 2)
    const cy = U(rng, b.y0 + mg + h / 2, b.y1 - mg - h / 2)
    const box = { x0: cx - w / 2 - 5, x1: cx + w / 2 + 5, y0: cy - h / 2 - 5, y1: cy + h / 2 + 5 }
    const hit = s.furniture.some((f) => !(f.bbox.x > box.x1 || f.bbox.x + f.bbox.w < box.x0 || f.bbox.y > box.y1 || f.bbox.y + f.bbox.h < box.y0))
    if (hit && attempt < 60) continue
    const poly =
      shape === 'rect' || shape === 'sloppy-rect'
        ? shapeRect(rng, cx, cy, w, h, au, shape === 'sloppy-rect')
        : shapeRound(rng, cx, cy, w / 2, h / 2, shape !== 'circle')
    const note = amb
      ? shape === 'tiny-blob'
        ? 'ambiguous: tiny closed blob, could be markup loop'
        : 'ambiguous: sloppy unclosed rect'
      : `furniture ${shape} in ${room.label}`
    return { poly, note, open: false }
  }
  throw new Error('no furniture spot')
}

function scribble(rng, center, hu, hv, theta, passes) {
  // zig-zag: advance along u (half extent hu), swing along v (half extent hv)
  const u = { x: Math.cos(theta), y: Math.sin(theta) }
  const v = perp(u)
  const poly = []
  for (let i = 0; i <= passes; i++) {
    const a = -hu + (2 * hu * i) / passes
    const sw = (i % 2 === 0 ? -1 : 1) * hv * U(rng, 0.9, 1.1)
    poly.push(add(add(center, mul(u, a)), mul(v, sw)))
  }
  return poly
}

function genDelete(ctx, rng, amb) {
  const { s } = ctx
  const onWall = amb || rng() < 0.25
  const theta = U(rng, 0.4, 1.2) * sgn(rng) + (rng() < 0.5 ? 0 : Math.PI / 2)
  if (!onWall) {
    const cands = s.furniture.filter((f) => Math.max(f.bbox.w, f.bbox.h) >= 12)
    const f = pick(rng, cands)
    const c = { x: f.bbox.x + f.bbox.w / 2, y: f.bbox.y + f.bbox.h / 2 }
    const r = Math.hypot(f.bbox.w, f.bbox.h) / 2
    const hu = Math.max(8, r * 0.95)
    const hv = Math.max(8, r * 0.75)
    return { poly: scribble(rng, c, hu, hv, theta, 2 * Math.floor(U(rng, 3, 6))), note: `target:${f.id}`, target: f.id }
  }
  const cands = s.walls.filter((w) => len(sub(w.centerline[1], w.centerline[0])) > 2.5 * M)
  const w = pick(rng, cands)
  const a = w.centerline[0]
  const b = w.centerline[1]
  const L = len(sub(b, a))
  const u = norm(sub(b, a))
  const t = U(rng, 1 * M, L - 1 * M)
  const c = add(a, mul(u, t))
  const th = Math.atan2(u.y, u.x)
  const hu = U(rng, 0.45, 0.8) * M
  const hv = amb ? 6 : 9
  return {
    poly: scribble(rng, c, hu, hv, th + U(rng, -0.15, 0.15), 2 * Math.floor(U(rng, 3, 6))),
    note: `${amb ? 'ambiguous: small scribble over wall, could be markup; ' : ''}target:${w.id}`,
    target: w.id,
  }
}

function genMarkup(ctx, rng, amb, idx) {
  const { s } = ctx
  const kinds = ['squiggle', 'arrow', 'textloops', 'cloud', 'underline', 'circleloop']
  let kind = kinds[idx % kinds.length]
  if (amb) kind = rng() < 0.5 ? 'underline-long' : 'circle-small'
  const lab = pick(rng, s.labels)
  const anchor = () => ({ x: Math.max(60, Math.min(900, lab.at.x + U(rng, -80, 80))), y: Math.max(60, Math.min(780, lab.at.y + U(rng, -60, 60))) })
  const th = U(rng, -0.35, 0.35)
  if (kind === 'squiggle') {
    const p0 = anchor()
    const Lr = U(rng, 60, 150)
    const lam = U(rng, 10, 18)
    const A = U(rng, 3, 7)
    const ph = U(rng, 0, 6.28)
    const poly = []
    for (let x = 0; x <= Lr; x += 1) poly.push(add(p0, rot({ x, y: A * Math.sin((2 * Math.PI * x) / lam) + 0.4 * A * Math.sin((2 * Math.PI * x) / (lam * 0.37) + ph) }, th)))
    return { poly, note: 'markup: handwriting squiggle' }
  }
  if (kind === 'textloops') {
    const p0 = anchor()
    const r = U(rng, 3.5, 6)
    const n = Math.floor(U(rng, 4, 8))
    const poly = []
    for (let t = 0; t <= n * 2 * Math.PI; t += 0.15) poly.push(add(p0, rot({ x: 0.6 * r * t + r * Math.sin(t) * 0.9, y: -r * Math.cos(t) }, th)))
    return { poly, note: 'markup: text-like cursive loops' }
  }
  if (kind === 'arrow') {
    const p0 = anchor()
    const d = rot({ x: 1, y: 0 }, U(rng, 0, 6.28))
    const p1 = add(p0, mul(d, U(rng, 40, 100)))
    const wingA = add(p1, mul(rot(d, Math.PI - 0.45), 12))
    const wingB = add(p1, mul(rot(d, Math.PI + 0.45), 12))
    return { poly: [p0, p1, wingA, p1, wingB], note: 'markup: arrow with head' }
  }
  if (kind === 'cloud') {
    const c = anchor()
    const w = U(rng, 70, 140)
    const h = U(rng, 40, 80)
    const q = [
      { x: c.x - w / 2, y: c.y - h / 2 },
      { x: c.x + w / 2, y: c.y - h / 2 },
      { x: c.x + w / 2, y: c.y + h / 2 },
      { x: c.x - w / 2, y: c.y + h / 2 },
      { x: c.x - w / 2, y: c.y - h / 2 },
    ]
    const poly = []
    for (let i = 0; i < 4; i++) {
      const a = q[i]
      const b = q[i + 1]
      const side = len(sub(b, a))
      const nS = Math.max(2, Math.round(side / 14))
      const out = perp(norm(sub(b, a))) // y-down, clockwise: perp points outward-left; flip below
      for (let k = 0; k < nS; k++) {
        for (let j = 0; j <= 8; j++) {
          const t = j / 8
          const base = lerp(a, b, (k + t) / nS)
          poly.push(add(base, mul(out, -6 * Math.sin(Math.PI * t))))
        }
      }
    }
    return { poly, note: 'markup: revision cloud', open: false }
  }
  if (kind === 'underline') {
    const tw = lab.text.length * 4.2 + 8
    const p0 = { x: lab.at.x - tw / 2, y: lab.at.y + 7 }
    const poly = []
    for (let x = 0; x <= tw; x += 1) poly.push({ x: p0.x + x, y: p0.y + 0.015 * x + 1.1 * Math.sin(x / 5) })
    return { poly, note: `markup: underline under label ${lab.text}` }
  }
  if (kind === 'circleloop') {
    const tw = lab.text.length * 4.2 + 12
    return { poly: shapeRound(rng, lab.at.x, lab.at.y, tw / 2 + 4, 10, false), note: `markup: circle around label ${lab.text}`, open: false }
  }
  if (kind === 'underline-long') {
    const p0 = anchor()
    const Lr = U(rng, 55, 100)
    return { poly: [p0, add(p0, rot({ x: Lr, y: 0 }, th * 0.3))], note: 'ambiguous: clean straight underline, could be a wall' }
  }
  const c = anchor()
  return { poly: shapeRound(rng, c.x, c.y, 10, 10, false), note: 'ambiguous: small circle, could be furniture', open: false }
}

// ───────────────────────────── main ─────────────────────────────

const sheets = loadSheets()
const index = []
const counts = {}
for (const kind of KINDS) {
  const dir = join(OUT, kind)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const koff = hashStr(kind) % 7
  for (let i = 0; i < PER_KIND; i++) {
    const id = `${kind}-${String(i).padStart(3, '0')}`
    const rng = mulberry32(hashStr(id) ^ 0x9e3779b9)
    const ctx = sheets[(i + koff) % sheets.length]
    const authorName = AUTHOR_NAMES[(i + koff) % 3]
    const au = AUTHORS[authorName]
    const amb = i % 7 === 3
    const heldout = i % 5 === 4
    let g
    let tool = 'brush'
    let opts = { open: true }
    if (kind === 'wall') g = genWall(ctx, rng, amb)
    else if (kind === 'door') g = genDoor(ctx, rng, amb)
    else if (kind === 'furniture') {
      g = genFurniture(ctx, rng, amb, au)
      opts = { open: false }
    } else if (kind === 'delete') {
      g = genDelete(ctx, rng, amb)
      opts = { open: false, profile: 'scribble', speedMul: 1.4 }
      if (i % 4 === 1) tool = 'eraser'
    } else {
      g = genMarkup(ctx, rng, amb, i)
      if (g.open === false) opts = { open: false }
    }
    const points = simulate(g.poly, au, rng, opts)
    const note = tool === 'eraser' ? `${g.note}; tool:eraser` : g.note
    const rec = {
      pdf: ctx.pdf,
      sheet: ctx.page,
      label: { kind, note },
      points,
      tool,
      author: authorName,
      expectedOp: OPS[kind],
      split: heldout ? 'heldout' : 'train',
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec))
    index.push({ id, kind, pdf: ctx.pdf, sheet: ctx.page, author: authorName, split: rec.split, ambiguous: amb, tool, points: points.length, durationMs: points[points.length - 1].t })
    const key = `${kind}/${rec.split}`
    counts[key] = (counts[key] ?? 0) + 1
  }
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1))
console.log(counts)
