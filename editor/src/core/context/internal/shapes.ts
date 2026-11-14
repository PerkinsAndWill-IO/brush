import type { Point, RawPath } from '../../types'
import { bboxOf, hyp, type BBox } from './math'

export type PathKind = 'normal' | 'round' | 'rect' | 'curvy'

export interface PathInfo {
  kind: PathKind
  pts: Point[] // deduped, without closing duplicate
  closed: boolean
  bbox: BBox
  cx: number
  cy: number
  /** round: radius. */
  r?: number
  /** rect: side lengths (w along first edge) and axis angle in [0,PI). */
  w?: number
  h?: number
  axisAligned?: boolean
}

export function classifyPath(p: RawPath): PathInfo {
  const pts: Point[] = []
  for (const q of p.points) {
    const l = pts[pts.length - 1]
    if (!l || Math.abs(l.x - q.x) > 1e-6 || Math.abs(l.y - q.y) > 1e-6) pts.push(q)
  }
  let closed = p.closed
  if (pts.length > 2 && hyp(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) {
    pts.pop()
    closed = true
  }
  const bbox = pts.length ? bboxOf(pts) : { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  const cx = (bbox.minX + bbox.maxX) / 2
  const cy = (bbox.minY + bbox.maxY) / 2
  const info: PathInfo = { kind: 'normal', pts, closed, bbox, cx, cy }
  const bw = bbox.maxX - bbox.minX
  const bh = bbox.maxY - bbox.minY

  if (closed && pts.length >= 8 && bw > 0 && bh > 0 && Math.abs(bw - bh) <= 0.2 * Math.max(bw, bh)) {
    const r = (bw + bh) / 4
    let ok = true
    for (const q of pts) if (Math.abs(hyp(q.x - cx, q.y - cy) - r) > 0.14 * r) ok = false
    if (ok) {
      info.kind = 'round'
      info.r = r
      return info
    }
  }
  if (closed && pts.length === 4) {
    const e = pts.map((q, i) => {
      const n = pts[(i + 1) % 4]
      return { x: n.x - q.x, y: n.y - q.y }
    })
    const l = e.map((v) => hyp(v.x, v.y))
    let ok = l.every((v) => v > 1e-6)
    if (ok) {
      for (let i = 0; i < 4; i++) {
        const a = e[i]
        const b = e[(i + 1) % 4]
        if (Math.abs(a.x * b.x + a.y * b.y) / (l[i] * l[(i + 1) % 4]) > 0.12) ok = false
      }
      if (Math.abs(l[0] - l[2]) > 0.12 * Math.max(l[0], l[2]) + 0.5) ok = false
      if (Math.abs(l[1] - l[3]) > 0.12 * Math.max(l[1], l[3]) + 0.5) ok = false
    }
    if (ok) {
      info.kind = 'rect'
      info.w = (l[0] + l[2]) / 2
      info.h = (l[1] + l[3]) / 2
      info.axisAligned = e.every((v) => Math.abs(v.x) <= 1 || Math.abs(v.y) <= 1)
      return info
    }
  }
  if (!closed && pts.length >= 4) {
    // curvy: consistent turning, or mostly short segments with real turning
    let pos = 0
    let neg = 0
    let total = 0
    let maxTurn = 0
    let short = 0
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i + 1].x - pts[i].x
      const ay = pts[i + 1].y - pts[i].y
      if (hyp(ax, ay) < 14) short++
      if (i + 2 < pts.length) {
        const bx = pts[i + 2].x - pts[i + 1].x
        const by = pts[i + 2].y - pts[i + 1].y
        const t = Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
        if (t > 0.02) pos++
        else if (t < -0.02) neg++
        total += t
        maxTurn = Math.max(maxTurn, Math.abs(t))
      }
    }
    const segs = pts.length - 1
    const absTotal = Math.abs(total)
    const consistent = (pos === 0 || neg === 0) && maxTurn <= (50 * Math.PI) / 180 && absTotal >= (40 * Math.PI) / 180 && absTotal <= (210 * Math.PI) / 180
    const shortCurve = short >= 0.6 * segs && absTotal >= (40 * Math.PI) / 180
    if (consistent || shortCurve) info.kind = 'curvy'
  }
  return info
}
