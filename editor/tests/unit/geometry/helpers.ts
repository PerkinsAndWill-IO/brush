import type { ContextItem, Point, StrokePoint } from '../../../src/core/types'

/** mulberry32 seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Dense polyline through the given corners, `step` pt apart, with deterministic jitter. */
export function densify(corners: Point[], step: number, noise = 0, seed = 1): Point[] {
  const r = rng(seed)
  const out: Point[] = []
  for (let i = 0; i < corners.length - 1; i++) {
    const a = corners[i]
    const b = corners[i + 1]
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      out.push({ x: a.x + (b.x - a.x) * t + (r() - 0.5) * 2 * noise, y: a.y + (b.y - a.y) * t + (r() - 0.5) * 2 * noise })
    }
  }
  out.push({ ...corners[corners.length - 1] })
  return out
}

export function arcPoints(cx: number, cy: number, rad: number, a0: number, a1: number, n: number, noise = 0, seed = 2): Point[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / (n - 1)
    return { x: cx + rad * Math.cos(a) + (r() - 0.5) * 2 * noise, y: cy + rad * Math.sin(a) + (r() - 0.5) * 2 * noise }
  })
}

/** Attach 8 ms-spaced timestamps. */
export function timed(pts: Point[], dtMs = 8): StrokePoint[] {
  return pts.map((p, i) => ({ x: p.x, y: p.y, t: i * dtMs }))
}

export function wall(id: string, pts: Point[], kind: ContextItem['kind'] = 'wall', confidence = 1): ContextItem {
  return { id, kind, geometry: { points: pts, closed: false }, confidence }
}
