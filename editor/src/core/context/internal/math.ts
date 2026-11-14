import type { Point } from '../../types'

export const DEG = Math.PI / 180

export function hyp(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy)
}

/** Undirected angle of a vector in [0, PI). */
export function undirectedAngle(dx: number, dy: number): number {
  let a = Math.atan2(dy, dx)
  if (a < 0) a += Math.PI
  if (a >= Math.PI - 1e-12) a = 0
  return a
}

/** Acute difference between two undirected angles, in [0, PI/2]. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI
  return d > Math.PI / 2 ? Math.PI - d : d
}

export function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return hyp(px - (ax + t * dx), py - (ay + t * dy))
}

export function pointInPolygon(x: number, y: number, pts: Point[]): boolean {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

export function signedArea(pts: Point[]): number {
  let s = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j].x * pts[i].y - pts[i].x * pts[j].y
  return s / 2
}

export function polygonArea(pts: Point[]): number {
  return Math.abs(signedArea(pts))
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function bboxOf(pts: Point[]): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Distance from a point to a polygon boundary. */
export function distToPolygon(x: number, y: number, pts: Point[]): number {
  let best = Infinity
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const d = distPointSeg(x, y, pts[j].x, pts[j].y, pts[i].x, pts[i].y)
    if (d < best) best = d
  }
  return best
}

/** Ramer-Douglas-Peucker on a closed ring (iterative). */
export function simplifyRing(pts: Point[], tol: number): Point[] {
  const n = pts.length
  if (n <= 4) return pts.slice()
  // split ring at point 0 and the farthest point from it
  let far = 0
  let fd = -1
  for (let i = 1; i < n; i++) {
    const d = hyp(pts[i].x - pts[0].x, pts[i].y - pts[0].y)
    if (d > fd) {
      fd = d
      far = i
    }
  }
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[far] = 1
  const stack: Array<[number, number]> = [
    [0, far],
    [far, n],
  ]
  while (stack.length) {
    const [s, e] = stack.pop()!
    const a = pts[s]
    const b = pts[e % n]
    let md = -1
    let mi = -1
    for (let i = s + 1; i < e; i++) {
      const d = distPointSeg(pts[i].x, pts[i].y, a.x, a.y, b.x, b.y)
      if (d > md) {
        md = d
        mi = i
      }
    }
    if (md > tol && mi >= 0) {
      keep[mi] = 1
      stack.push([s, mi], [mi, e])
    }
  }
  const out: Point[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i])
  return out
}
