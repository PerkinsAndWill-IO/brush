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
  const hash = new SpatialHash(40, segs.length)
  for (const i of short) {
    const s = segs[i]
    hash.insert(i, Math.min(s.ax, s.bx), Math.min(s.ay, s.by), Math.max(s.ax, s.bx), Math.max(s.ay, s.by))
  }
  const out: number[] = []
  for (const i of short) {
    const s = segs[i]
    const mx = (s.ax + s.bx) / 2
    const my = (s.ay + s.by) / 2
    hash.query(mx - 30, my - 30, mx + 30, my + 30, out)
    let n = 0
    for (const j of out) {
      if (j === i) continue
      const t = segs[j]
      if (angleDiff(s.ang, t.ang) > 0.06) continue
      const tx = (t.ax + t.bx) / 2
      const ty = (t.ay + t.by) / 2
      if (hyp(tx - mx, ty - my) > 30) continue
      const off = Math.abs((tx - mx) * -s.uy + (ty - my) * s.ux)
      if (off < 1 || off > 25) continue
      // must overlap along the axis
      const along = Math.abs((tx - mx) * s.ux + (ty - my) * s.uy)
      if (along > (s.len + t.len) / 2 * 0.8) continue
      n++
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
