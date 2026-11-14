import type { Point } from '../../types'
import { SpatialHash } from './hash'
import { angleDiff, distPointSeg, hyp, undirectedAngle } from './math'
import type { Seg } from './segments'

export type RunKind = 'pair' | 'thick' | 'poche'

export interface WallRun {
  ax: number
  ay: number
  bx: number
  by: number
  thick: number
  kind: RunKind
  lw: number
  /** 1 if both lines of a pair have matching line weights (length-weighted for merged runs). */
  sameLw: number
  connected: number // endpoints joined to other walls, 0..2
}

const ANG_TOL = (2.5 * Math.PI) / 180

interface Cand {
  i: number
  j: number
  lo: number
  hi: number
  oa: number
  ob: number
  tj0: number
  tj1: number
  sameDir: boolean
}

function overlapFrac(used: Array<Array<[number, number]>>, id: number, lo: number, hi: number): number {
  const l = used[id]
  if (!l || hi <= lo) return 0
  let s = 0
  for (const [a, b] of l) s += Math.max(0, Math.min(hi, b) - Math.max(lo, a))
  return s / (hi - lo)
}

/** Pairs of parallel solid segments `lo..hi` pt apart with large overlap. */
export function findWallPairs(segs: Seg[], pool: number[], lo: number, hi: number): { runs: WallRun[]; used: Uint8Array } {
  const used = new Uint8Array(segs.length)
  const runs: WallRun[] = []
  const hash = new SpatialHash(Math.max(40, hi * 2), segs.length)
  for (const i of pool) {
    const s = segs[i]
    hash.insert(i, Math.min(s.ax, s.bx), Math.min(s.ay, s.by), Math.max(s.ax, s.bx), Math.max(s.ay, s.by))
  }
  const cands: Cand[] = []
  const out: number[] = []
  for (const i of pool) {
    const s = segs[i]
    hash.query(Math.min(s.ax, s.bx) - hi, Math.min(s.ay, s.by) - hi, Math.max(s.ax, s.bx) + hi, Math.max(s.ay, s.by) + hi, out)
    const nx = -s.uy
    const ny = s.ux
    for (const j of out) {
      if (j <= i) continue
      const t = segs[j]
      if (angleDiff(s.ang, t.ang) > ANG_TOL) continue
      // a heavy stroke next to a thin line is a wall (thick run) beside a door leaf or symbol, not a pair
      if (Math.max(s.lw, t.lw) >= 1.5 && Math.max(s.lw, t.lw) > 2 * Math.min(s.lw, t.lw)) continue
      let t0 = (t.ax - s.ax) * s.ux + (t.ay - s.ay) * s.uy
      let o0 = (t.ax - s.ax) * nx + (t.ay - s.ay) * ny
      let t1 = (t.bx - s.ax) * s.ux + (t.by - s.ay) * s.uy
      let o1 = (t.bx - s.ax) * nx + (t.by - s.ay) * ny
      const sameDir = t.ux * s.ux + t.uy * s.uy > 0
      if (t0 > t1) {
        const tt = t0
        t0 = t1
        t1 = tt
        const oo = o0
        o0 = o1
        o1 = oo
      }
      const lo_ = Math.max(0, t0)
      const hi_ = Math.min(s.len, t1)
      const ov = hi_ - lo_
      if (ov < 12 || ov < 0.2 * Math.min(s.len, t.len) || t1 - t0 < 1e-9) continue
      const oAt = (x: number) => o0 + (o1 - o0) * ((x - t0) / (t1 - t0))
      const oa = oAt(lo_)
      const ob = oAt(hi_)
      if (oa * ob <= 0) continue
      const da = Math.abs(oa)
      const db = Math.abs(ob)
      if (da < lo || da > hi || db < lo || db > hi || Math.abs(da - db) > 2.5) continue
      cands.push({ i, j, lo: lo_, hi: hi_, oa, ob, tj0: t0, tj1: t1, sameDir })
    }
  }
  cands.sort((a, b) => {
    const ova = Math.round(a.hi - a.lo)
    const ovb = Math.round(b.hi - b.lo)
    if (ova !== ovb) return ovb - ova
    const da = Math.abs(a.oa) + Math.abs(a.ob)
    const db = Math.abs(b.oa) + Math.abs(b.ob)
    return da - db || a.i - b.i || a.j - b.j
  })
  const usedIv: Array<Array<[number, number]>> = new Array(segs.length)
  for (const c of cands) {
    const s = segs[c.i]
    const t = segs[c.j]
    // interval on t's own parameter
    const toT = (x: number) => (c.sameDir ? x - c.tj0 : c.tj1 - x)
    let ta = toT(c.lo)
    let tb = toT(c.hi)
    if (ta > tb) {
      const tt = ta
      ta = tb
      tb = tt
    }
    if (overlapFrac(usedIv, c.i, c.lo, c.hi) > 0.3 || overlapFrac(usedIv, c.j, ta, tb) > 0.3) continue
    ;(usedIv[c.i] ??= []).push([c.lo, c.hi])
    ;(usedIv[c.j] ??= []).push([ta, tb])
    used[c.i] = 1
    used[c.j] = 1
    const nx = -s.uy
    const ny = s.ux
    runs.push({
      ax: s.ax + s.ux * c.lo + (nx * c.oa) / 2,
      ay: s.ay + s.uy * c.lo + (ny * c.oa) / 2,
      bx: s.ax + s.ux * c.hi + (nx * c.ob) / 2,
      by: s.ay + s.uy * c.hi + (ny * c.ob) / 2,
      thick: (Math.abs(c.oa) + Math.abs(c.ob)) / 2,
      kind: 'pair',
      lw: Math.max(s.lw, t.lw),
      sameLw: Math.abs(s.lw - t.lw) <= 0.25 ? 1 : 0,
      connected: 0,
    })
  }
  return { runs, used }
}

/** Union runs that are collinear, equal in thickness and touching. Returns merged runs. */
export function mergeCollinear(runs: WallRun[], offTol = 2.0, thickTol = 2.5, gapTol = 2.5): WallRun[] {
  const n = runs.length
  if (n < 2) return runs.slice()
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const ang = runs.map((r) => undirectedAngle(r.bx - r.ax, r.by - r.ay))
  const len = runs.map((r) => hyp(r.bx - r.ax, r.by - r.ay))
  const NB = 90
  const binOf = (a: number) => Math.floor(a / (Math.PI / NB)) % NB
  const bins = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const b = binOf(ang[i])
    const l = bins.get(b)
    if (l) l.push(i)
    else bins.set(b, [i])
  }
  for (let i = 0; i < n; i++) {
    const bi = binOf(ang[i])
    for (const bb of [bi - 1, bi, bi + 1]) {
      const l = bins.get(((bb % NB) + NB) % NB)
      if (!l) continue
      for (const j of l) {
        if (j <= i) continue
        const a = runs[i]
        const b = runs[j]
        if (a.kind !== b.kind || Math.abs(a.thick - b.thick) > thickTol) continue
        if (angleDiff(ang[i], ang[j]) > 0.04) continue
        const ref = len[i] >= len[j] ? i : j
        const oth = ref === i ? j : i
        const r = runs[ref]
        const o = runs[oth]
        const ux = (r.bx - r.ax) / len[ref]
        const uy = (r.by - r.ay) / len[ref]
        const o1 = (o.ax - r.ax) * -uy + (o.ay - r.ay) * ux
        const o2 = (o.bx - r.ax) * -uy + (o.by - r.ay) * ux
        if (Math.abs(o1) > offTol || Math.abs(o2) > offTol) continue
        const t1 = (o.ax - r.ax) * ux + (o.ay - r.ay) * uy
        const t2 = (o.bx - r.ax) * ux + (o.by - r.ay) * uy
        const gap = Math.max(Math.min(t1, t2) - len[ref], -Math.max(t1, t2))
        if (gap > gapTol) continue
        parent[find(i)] = find(j)
      }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const g = find(i)
    const l = groups.get(g)
    if (l) l.push(i)
    else groups.set(g, [i])
  }
  const out: WallRun[] = []
  for (const g of [...groups.keys()].sort((a, b) => a - b)) {
    const m = groups.get(g)!
    if (m.length === 1) {
      out.push(runs[m[0]])
      continue
    }
    let ref = m[0]
    for (const k of m) if (len[k] > len[ref]) ref = k
    const r0 = runs[ref]
    const ux = (r0.bx - r0.ax) / len[ref]
    const uy = (r0.by - r0.ay) / len[ref]
    let tmin = Infinity
    let tmax = -Infinity
    let wsum = 0
    let off = 0
    let th = 0
    let same = 0
    let lw = 0
    for (const k of m) {
      const r = runs[k]
      const w = len[k]
      const ta = (r.ax - r0.ax) * ux + (r.ay - r0.ay) * uy
      const tb = (r.bx - r0.ax) * ux + (r.by - r0.ay) * uy
      tmin = Math.min(tmin, ta, tb)
      tmax = Math.max(tmax, ta, tb)
      const oa = (r.ax - r0.ax) * -uy + (r.ay - r0.ay) * ux
      const ob = (r.bx - r0.ax) * -uy + (r.by - r0.ay) * ux
      off += (w * (oa + ob)) / 2
      th += w * r.thick
      same += w * r.sameLw
      lw = Math.max(lw, r.lw)
      wsum += w
    }
    off /= wsum
    out.push({
      ax: r0.ax + ux * tmin - uy * off,
      ay: r0.ay + uy * tmin + ux * off,
      bx: r0.ax + ux * tmax - uy * off,
      by: r0.ay + uy * tmax + ux * off,
      thick: th / wsum,
      kind: r0.kind,
      lw,
      sameLw: same / wsum,
      connected: 0,
    })
  }
  return out
}

/** Snap endpoints of walls onto the intersection with non-parallel neighbours; counts connections. */
export function snapCorners(runs: WallRun[]): void {
  const n = runs.length
  const hash = new SpatialHash(40, n)
  for (let i = 0; i < n; i++) {
    const r = runs[i]
    hash.insert(i, Math.min(r.ax, r.bx) - 15, Math.min(r.ay, r.by) - 15, Math.max(r.ax, r.bx) + 15, Math.max(r.ay, r.by) + 15)
  }
  const moves: Array<[number, number, number, number]> = [] // run, end(0/1), x, y
  const conn = new Array<number>(n).fill(0)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const r = runs[i]
    const len = hyp(r.bx - r.ax, r.by - r.ay)
    if (len < 1e-9) continue
    const ux = (r.bx - r.ax) / len
    const uy = (r.by - r.ay) / len
    for (let e = 0; e < 2; e++) {
      const ex = e === 0 ? r.ax : r.bx
      const ey = e === 0 ? r.ay : r.by
      hash.query(ex - 1, ey - 1, ex + 1, ey + 1, out)
      let best: { x: number; y: number; d: number } | undefined
      let connected = false
      for (const j of out) {
        if (j === i) continue
        const q = runs[j]
        const ql = hyp(q.bx - q.ax, q.by - q.ay)
        if (ql < 1e-9) continue
        const qx = (q.bx - q.ax) / ql
        const qy = (q.by - q.ay) / ql
        if (angleDiff(undirectedAngle(ux, uy), undirectedAngle(qx, qy)) < 0.5) continue
        const L = Math.max(r.thick, q.thick) + 3
        if (distPointSeg(ex, ey, q.ax, q.ay, q.bx, q.by) <= L) connected = true
        // solve e + s*u = q.a + t*qv
        const det = ux * -qy - uy * -qx
        if (Math.abs(det) < 1e-6) continue
        const dx = q.ax - ex
        const dy = q.ay - ey
        const s = (dx * -qy - dy * -qx) / det
        const t = (ux * dy - uy * dx) / det
        if (Math.abs(s) > L || t < -L || t > ql + L) continue
        const d = Math.abs(s)
        if (!best || d < best.d) best = { x: ex + s * ux, y: ey + s * uy, d }
      }
      if (connected || best) conn[i]++
      if (best) moves.push([i, e, best.x, best.y])
    }
  }
  for (const [i, e, x, y] of moves) {
    if (e === 0) {
      runs[i].ax = x
      runs[i].ay = y
    } else {
      runs[i].bx = x
      runs[i].by = y
    }
  }
  for (let i = 0; i < n; i++) runs[i].connected = Math.min(2, conn[i])
}

export interface OpeningHit {
  a: Point
  b: Point
  widthPt: number
  hostA: number
  hostB: number
  hinge: Point
}

/** Gaps between collinear wall runs bridged by a quarter-circle (door swing) arc. */
export function findOpenings(runs: WallRun[], arcs: Point[][], gapMin: number, gapMax: number): OpeningHit[] {
  const hits: OpeningHit[] = []
  const n = runs.length
  if (!arcs.length || n < 2 || n > 4000) return hits
  for (let i = 0; i < n; i++) {
    const a = runs[i]
    const la = hyp(a.bx - a.ax, a.by - a.ay)
    if (la < 1e-9) continue
    const ux = (a.bx - a.ax) / la
    const uy = (a.by - a.ay) / la
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const b = runs[j]
      if (Math.abs(a.thick - b.thick) > 3) continue
      const o1 = (b.ax - a.ax) * -uy + (b.ay - a.ay) * ux
      const o2 = (b.bx - a.ax) * -uy + (b.by - a.ay) * ux
      if (Math.abs(o1) > 3 || Math.abs(o2) > 3) continue
      const t1 = (b.ax - a.ax) * ux + (b.ay - a.ay) * uy
      const t2 = (b.bx - a.ax) * ux + (b.by - a.ay) * uy
      const tb0 = Math.min(t1, t2)
      const gap = tb0 - la
      if (gap < gapMin || gap > gapMax) continue // b must start beyond a's b-end
      const e1 = { x: a.ax + ux * la, y: a.ay + uy * la }
      const e2 = { x: a.ax + ux * tb0, y: a.ay + uy * tb0 }
      const hinge = matchArc(arcs, e1, e2, gap)
      if (!hinge) continue
      hits.push({ a: e1, b: e2, widthPt: gap, hostA: i, hostB: j, hinge })
    }
  }
  return hits
}

function matchArc(arcs: Point[][], e1: Point, e2: Point, gap: number): Point | undefined {
  for (const arc of arcs) {
    for (const [h, far] of [
      [e1, e2],
      [e2, e1],
    ] as const) {
      const q = arc.filter((p) => Math.abs(hyp(p.x - h.x, p.y - h.y) - gap) <= 0.14 * gap)
      if (q.length < 3 || q.length < 0.6 * arc.length) continue
      const a0 = Math.atan2(q[0].y - h.y, q[0].x - h.x)
      let span = 0
      for (const p of q) {
        let d = Math.atan2(p.y - h.y, p.x - h.x) - a0
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        span = Math.max(span, Math.abs(d))
      }
      if (span < (60 * Math.PI) / 180 || span > (115 * Math.PI) / 180) continue
      let nearFar = Infinity
      for (const p of q) nearFar = Math.min(nearFar, hyp(p.x - far.x, p.y - far.y))
      if (nearFar <= 0.25 * gap) return { x: h.x, y: h.y }
    }
  }
  return undefined
}

/**
 * Door swing arcs whose leaf lies in a wall line but whose two sides are not a single clean gap
 * (e.g. two doors share one stub between them). The hinge is the arc centre; the opening runs from
 * the hinge to the arc end that lies along a wall. Needs a wall run ending near the opening.
 */
export function findArcOpenings(runs: WallRun[], arcs: Point[][], known: OpeningHit[], gapMin: number, gapMax: number): OpeningHit[] {
  const hits: OpeningHit[] = []
  const lens = runs.map((r) => hyp(r.bx - r.ax, r.by - r.ay))
  for (const arc of arcs) {
    if (arc.length < 4) continue
    const P = arc[0]
    const Q = arc[arc.length - 1]
    const d = hyp(Q.x - P.x, Q.y - P.y)
    const r = d / Math.SQRT2
    if (r < gapMin || r > gapMax) continue
    const mid = arc[Math.floor(arc.length / 2)]
    const M = { x: (P.x + Q.x) / 2, y: (P.y + Q.y) / 2 }
    const nx = -(Q.y - P.y) / d
    const ny = (Q.x - P.x) / d
    for (const sgn of [1, -1]) {
      const c = { x: M.x + (sgn * nx * d) / 2, y: M.y + (sgn * ny * d) / 2 }
      if (Math.abs(hyp(mid.x - c.x, mid.y - c.y) - r) > 0.12 * r) continue
      if (known.some((k) => hyp(k.hinge.x - c.x, k.hinge.y - c.y) <= 3)) continue
      for (const E of [P, Q]) {
        const sx = E.x - c.x
        const sy = E.y - c.y
        const sl = hyp(sx, sy)
        if (sl < 1e-9) continue
        const sAng = undirectedAngle(sx, sy)
        let hostE = -1
        let hostC = -1
        let bestE = Infinity
        let bestC = Infinity
        let blocked = false
        for (let i = 0; i < runs.length; i++) {
          const w = runs[i]
          if (lens[i] < 1e-9) continue
          if (angleDiff(sAng, undirectedAngle(w.bx - w.ax, w.by - w.ay)) > 0.06) continue
          const tol = w.thick / 2 + 3
          const dc = distLine(c, w)
          const de = distLine(E, w)
          if (dc > tol || de > tol) continue
          // the swept segment must be open: its midpoint is not on the run
          const m = { x: (c.x + E.x) / 2, y: (c.y + E.y) / 2 }
          if (distPointSeg(m.x, m.y, w.ax, w.ay, w.bx, w.by) <= tol) blocked = true
          for (const [pt, kind] of [
            [E, 0],
            [c, 1],
          ] as const) {
            const de2 = Math.min(hyp(pt.x - w.ax, pt.y - w.ay), hyp(pt.x - w.bx, pt.y - w.by))
            if (kind === 0 && de2 < bestE) {
              bestE = de2
              hostE = i
            }
            if (kind === 1 && de2 < bestC) {
              bestC = de2
              hostC = i
            }
          }
        }
        if (blocked) continue
        const lim = 0.5 * r + 6
        const okE = hostE >= 0 && bestE <= lim
        const okC = hostC >= 0 && bestC <= lim
        if (!okE && !okC) continue
        const mx = (c.x + E.x) / 2
        const my = (c.y + E.y) / 2
        if ([...known, ...hits].some((k) => hyp((k.a.x + k.b.x) / 2 - mx, (k.a.y + k.b.y) / 2 - my) < 0.5 * sl)) continue
        const hA = okE ? hostE : hostC
        const hB = okC ? hostC : hostE
        hits.push({ a: c, b: { x: E.x, y: E.y }, widthPt: sl, hostA: hA, hostB: hB, hinge: c })
        break
      }
    }
  }
  return hits
}

function distLine(p: Point, w: WallRun): number {
  const l = hyp(w.bx - w.ax, w.by - w.ay)
  return Math.abs((p.x - w.ax) * -(w.by - w.ay) + (p.y - w.ay) * (w.bx - w.ax)) / l
}

/**
 * Poché polygon (a filled closed outline, not just a rectangle: L/T shapes, walls with jogs) -> wall runs.
 * Each pair of opposite parallel edges `lo..hi` apart that overlap by at least half the shorter edge gives one
 * run along their midline. CAD/BIM exports draw cut walls this way; layer names are gone.
 */
export function pocheFromPolygon(pts: Point[], lo: number, hi: number, lw: number): WallRun[] {
  const n = pts.length
  const runs: WallRun[] = []
  if (n < 4 || n > 64) return runs
  const E: Array<{ ax: number; ay: number; ux: number; uy: number; len: number; ang: number }> = []
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const len = hyp(b.x - a.x, b.y - a.y)
    E.push({ ax: a.x, ay: a.y, ux: len ? (b.x - a.x) / len : 0, uy: len ? (b.y - a.y) / len : 0, len, ang: undirectedAngle(b.x - a.x, b.y - a.y) })
  }
  for (let i = 0; i < n; i++) {
    const e = E[i]
    if (e.len < Math.max(6, lo)) continue
    for (let j = i + 1; j < n; j++) {
      const f = E[j]
      if (f.len < Math.max(6, lo) || angleDiff(e.ang, f.ang) > ANG_TOL) continue
      // opposite sides of a polygon run in opposite directions
      if (e.ux * f.ux + e.uy * f.uy > 0) continue
      const off = (f.ax - e.ax) * -e.uy + (f.ay - e.ay) * e.ux
      const d = Math.abs(off)
      if (d < lo || d > hi) continue
      const t0 = (f.ax - e.ax) * e.ux + (f.ay - e.ay) * e.uy
      const t1 = t0 + f.len * (f.ux * e.ux + f.uy * e.uy)
      const s0 = Math.max(0, Math.min(t0, t1))
      const s1 = Math.min(e.len, Math.max(t0, t1))
      if (s1 - s0 < 0.5 * Math.min(e.len, f.len) || s1 - s0 < 1.5 * d) continue
      const mx = (-e.uy * off) / 2
      const my = (e.ux * off) / 2
      runs.push({ ax: e.ax + e.ux * s0 + mx, ay: e.ay + e.uy * s0 + my, bx: e.ax + e.ux * s1 + mx, by: e.ay + e.uy * s1 + my, thick: d, kind: 'poche', lw, sameLw: 1, connected: 0 })
    }
  }
  return runs
}

/**
 * Drop runs that belong to stripe arrays (parking bays, terrace / zebra hatches, stair treads drawn as pairs):
 * a run with `minNeighbours` or more near-parallel runs of similar length, overlapping along its axis and within
 * `maxOffset` pt across it. Walls are never stacked that densely.
 */
export function dropStripeArrays(runs: WallRun[], maxOffset: number, minNeighbours = 3): WallRun[] {
  const n = runs.length
  const info = runs.map((r) => {
    const len = hyp(r.bx - r.ax, r.by - r.ay)
    return { len, ang: undirectedAngle(r.bx - r.ax, r.by - r.ay), ux: len ? (r.bx - r.ax) / len : 0, uy: len ? (r.by - r.ay) / len : 0, mx: (r.ax + r.bx) / 2, my: (r.ay + r.by) / 2 }
  })
  const hash = new SpatialHash(Math.max(40, maxOffset), n)
  for (let i = 0; i < n; i++) hash.insert(i, info[i].mx, info[i].my, info[i].mx, info[i].my)
  const out: number[] = []
  const keep: WallRun[] = []
  for (let i = 0; i < n; i++) {
    const a = info[i]
    const R = maxOffset + a.len / 2
    hash.query(a.mx - R, a.my - R, a.mx + R, a.my + R, out, false)
    let k = 0
    for (const j of out) {
      if (j === i) continue
      const b = info[j]
      if (angleDiff(a.ang, b.ang) > 0.05 || Math.abs(a.len - b.len) > 0.25 * Math.max(a.len, b.len)) continue
      const dx = b.mx - a.mx
      const dy = b.my - a.my
      const across = Math.abs(dx * -a.uy + dy * a.ux)
      const along = Math.abs(dx * a.ux + dy * a.uy)
      if (across > 0.5 && across <= maxOffset && along <= 0.8 * a.len) k++
      if (k >= minNeighbours) break
    }
    if (k < minNeighbours) keep.push(runs[i])
  }
  return keep
}
