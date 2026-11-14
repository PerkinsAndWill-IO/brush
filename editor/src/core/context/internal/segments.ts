import type { RawText } from '../../types'
import { SpatialHash } from './hash'
import { angleDiff, distPointSeg, hyp, undirectedAngle } from './math'
import { isNumericDim } from '../text'
import { textCenter } from '../titleblock'

export interface Seg {
  ax: number
  ay: number
  bx: number
  by: number
  len: number
  ang: number // undirected [0,PI)
  ux: number
  uy: number
  lw: number
  dashed: boolean
  src: number
}

export function makeSeg(ax: number, ay: number, bx: number, by: number, lw: number, dashed: boolean, src: number): Seg | null {
  const dx = bx - ax
  const dy = by - ay
  const len = hyp(dx, dy)
  if (len < 0.5) return null
  return { ax, ay, bx, by, len, ang: undirectedAngle(dx, dy), ux: dx / len, uy: dy / len, lw, dashed, src }
}

/** Short parallel stacks of lines (hatching). Returns mask over segs. */
export function findHatch(segs: Seg[], pool: number[]): Uint8Array {
  const mask = new Uint8Array(segs.length)
  const short = pool.filter((i) => segs[i].len < 60)
  const m = short.length
  if (!m) return mask
  // Neighbours are tested by midpoint distance <= 30 and angle <= 0.06 rad, so bucket midpoints in a flat
  // (orientation bin, 30 pt cell) grid (counting sort, typed arrays) and scan 3 bins x 3x3 cells. Dense CAD
  // plans have ~150k short segments; a Map-based box hash spent seconds here.
  const BINS = 48
  const C = 30
  const mx = new Float64Array(m)
  const my = new Float64Array(m)
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let k = 0; k < m; k++) {
    const s = segs[short[k]]
    mx[k] = (s.ax + s.bx) / 2
    my[k] = (s.ay + s.by) / 2
    if (mx[k] < minX) minX = mx[k]
    if (my[k] < minY) minY = my[k]
    if (mx[k] > maxX) maxX = mx[k]
    if (my[k] > maxY) maxY = my[k]
  }
  const gw = Math.floor((maxX - minX) / C) + 1
  const gh = Math.floor((maxY - minY) / C) + 1
  const nCells = BINS * gw * gh
  const binOf = (ang: number) => Math.min(BINS - 1, Math.floor((ang / Math.PI) * BINS))
  const key = new Int32Array(m)
  const start = new Int32Array(nCells + 1)
  for (let k = 0; k < m; k++) {
    const cx = Math.floor((mx[k] - minX) / C)
    const cy = Math.floor((my[k] - minY) / C)
    key[k] = (binOf(segs[short[k]].ang) * gh + cy) * gw + cx
    start[key[k] + 1]++
  }
  for (let c = 0; c < nCells; c++) start[c + 1] += start[c]
  const fill = start.slice(0, nCells)
  const order = new Int32Array(m)
  for (let k = 0; k < m; k++) order[fill[key[k]]++] = k
  for (let k = 0; k < m; k++) {
    const i = short[k]
    const s = segs[i]
    const x = mx[k]
    const y = my[k]
    const cx = Math.floor((x - minX) / C)
    const cy = Math.floor((y - minY) / C)
    const b0 = binOf(s.ang)
    let n = 0
    for (let db = -1; db <= 1 && n < 3; db++) {
      const b = (b0 + db + BINS) % BINS
      for (let yy = Math.max(0, cy - 1); yy <= Math.min(gh - 1, cy + 1) && n < 3; yy++) {
        for (let xx = Math.max(0, cx - 1); xx <= Math.min(gw - 1, cx + 1) && n < 3; xx++) {
          const c = (b * gh + yy) * gw + xx
          for (let q = start[c]; q < start[c + 1]; q++) {
            const kk = order[q]
            if (kk === k) continue
            const t = segs[short[kk]]
            if (angleDiff(s.ang, t.ang) > 0.06) continue
            const dx = mx[kk] - x
            const dy = my[kk] - y
            if (dx * dx + dy * dy > 900) continue
            const off = Math.abs(dx * -s.uy + dy * s.ux)
            if (off < 1 || off > 25) continue
            // must overlap along the axis
            const along = Math.abs(dx * s.ux + dy * s.uy)
            if (along > ((s.len + t.len) / 2) * 0.8) continue
            if (++n >= 3) break
          }
        }
      }
    }
    if (n >= 3) mask[i] = 1
  }
  return mask
}

export interface DimLine {
  ax: number
  ay: number
  bx: number
  by: number
}

/** Thin lines with end ticks and nearby numeric text. */
export function findDimensions(segs: Seg[], pool: number[], texts: RawText[]): { mask: Uint8Array; lines: DimLine[] } {
  const mask = new Uint8Array(segs.length)
  const lines: DimLine[] = []
  const ticks = new SpatialHash(20, segs.length)
  for (const i of pool) {
    const s = segs[i]
    if (s.len <= 18)
      ticks.insert(i, Math.min(s.ax, s.bx), Math.min(s.ay, s.by), Math.max(s.ax, s.bx), Math.max(s.ay, s.by))
  }
  const numTexts = texts.filter((t) => isNumericDim(t.text)).map((t) => ({ ...textCenter(t), h: t.height }))
  const out: number[] = []
  for (const i of pool) {
    const s = segs[i]
    if (s.len < 15 || s.lw > 1.0 || s.dashed) continue
    const found: number[][] = [[], []]
    const ends = [
      [s.ax, s.ay],
      [s.bx, s.by],
    ]
    for (let e = 0; e < 2; e++) {
      const [ex, ey] = ends[e]
      ticks.query(ex - 3, ey - 3, ex + 3, ey + 3, out)
      for (const j of out) {
        if (j === i) continue
        const t = segs[j]
        if (angleDiff(s.ang, t.ang) < 0.2) continue
        if (distPointSeg(ex, ey, t.ax, t.ay, t.bx, t.by) <= 2) found[e].push(j)
      }
    }
    const tickEnds = (found[0].length ? 1 : 0) + (found[1].length ? 1 : 0)
    if (tickEnds === 0) continue
    let hasText = false
    for (const t of numTexts) {
      const along = (t.x - s.ax) * s.ux + (t.y - s.ay) * s.uy
      const off = Math.abs((t.x - s.ax) * -s.uy + (t.y - s.ay) * s.ux)
      if (along >= -8 && along <= s.len + 8 && off <= 14 + t.h) {
        hasText = true
        break
      }
    }
    if (hasText || (tickEnds === 2 && s.lw <= 0.3)) {
      mask[i] = 1
      for (const f of found) for (const j of f) mask[j] = 1
      lines.push({ ax: s.ax, ay: s.ay, bx: s.bx, by: s.by })
    }
  }
  return { mask, lines }
}

/**
 * Periodic stacks of parallel lines of similar length and uniform spacing: stair treads,
 * hatching, louvres. A wall pair is never part of such a stack (>= minCount lines at one pitch).
 * Walks chains of aligned parallel neighbours one pitch apart. Returns a mask over segs.
 */
export function findLadders(segs: Seg[], pool: number[], maxPitch = 24, minCount = 5): Uint8Array {
  const mask = new Uint8Array(segs.length)
  const hash = new SpatialHash(Math.max(maxPitch * 2, 48), segs.length)
  for (const i of pool) {
    const s = segs[i]
    hash.insert(i, Math.min(s.ax, s.bx), Math.min(s.ay, s.by), Math.max(s.ax, s.bx), Math.max(s.ay, s.by))
  }
  const out: number[] = []
  // bounded work: pathological dense input stops the search (remaining segments are simply not flagged)
  let budget = 400_000
  /** Neighbours of `cur` aligned with `s`, whose offset along s's normal from `cur` is within [lo, hi]. */
  const step = (s: Seg, cur: number, lo: number, hi: number): Array<[number, number]> => {
    const c = segs[cur]
    hash.query(Math.min(c.ax, c.bx) - hi, Math.min(c.ay, c.by) - hi, Math.max(c.ax, c.bx) + hi, Math.max(c.ay, c.by) + hi, out)
    const nx = -s.uy
    const ny = s.ux
    const res: Array<[number, number]> = []
    budget -= out.length
    for (const j of out) {
      if (j === cur) continue
      const t = segs[j]
      if (angleDiff(s.ang, t.ang) > 0.05 || Math.abs(t.len - s.len) > 0.15 * s.len + 2) continue
      const off = (t.ax - c.ax) * nx + (t.ay - c.ay) * ny
      if (off < lo || off > hi) continue
      const t0 = (t.ax - s.ax) * s.ux + (t.ay - s.ay) * s.uy
      const t1 = (t.bx - s.ax) * s.ux + (t.by - s.ay) * s.uy
      const ov = Math.min(s.len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1))
      if (ov < 0.7 * s.len) continue
      res.push([j, off])
    }
    return res
  }
  for (const i of pool) {
    if (mask[i]) continue
    if (budget <= 0) break
    const s = segs[i]
    for (const [j0, p] of step(s, i, 1.5, maxPitch)) {
      const chain = [i, j0]
      let cur = j0
      for (;;) {
        const nxt = step(s, cur, p * 0.85 - 0.3, p * 1.15 + 0.3)
        if (!nxt.length || chain.length > 400 || budget <= 0) break
        cur = nxt[0][0]
        chain.push(cur)
      }
      if (chain.length >= minCount) for (const k of chain) mask[k] = 1
    }
  }
  return mask
}
