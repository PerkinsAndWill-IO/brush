import type { ContextItem, Point, Rect } from '../types'
import { segmentDistance2, segmentIntersectsRect, closestPointOnSegment } from './vec'

const SHIFT = 524288
const KEY = 1048576
const cellKey = (cx: number, cy: number): number => (cx + SHIFT) * KEY + (cy + SHIFT)

export interface ItemHit {
  item: ContextItem
  /** Distance from the query point to the closest point on the item's geometry. */
  distance: number
  /** Closest point on the item's geometry. */
  point: Point
  /** Index of the closest segment within the item's path. */
  segIndex: number
}

export interface SpatialOptions {
  /** Grid cell size in points. Default: mean segment length clamped to 8..120. */
  cellSize?: number
}

/**
 * Uniform-grid spatial index over the segments of ContextItems. Every segment
 * is registered in each cell it crosses (grid traversal), so point, radius and
 * rect queries only look at nearby segments.
 */
export class SpatialIndex {
  readonly items: readonly ContextItem[]
  readonly cellSize: number
  private ax: Float64Array
  private ay: Float64Array
  private bx: Float64Array
  private by: Float64Array
  private segItem: Int32Array
  private segLocal: Int32Array
  private grid = new Map<number, number[]>()
  private minCx = Infinity
  private maxCx = -Infinity
  private minCy = Infinity
  private maxCy = -Infinity
  private stamp = 0
  private itemStamp: Int32Array
  private itemBest: Float64Array
  private itemSeg: Int32Array
  private itemPx: Float64Array
  private itemPy: Float64Array
  private byId = new Map<string, number>()

  constructor(items: readonly ContextItem[], opts: SpatialOptions = {}) {
    this.items = items
    const ax: number[] = []
    const ay: number[] = []
    const bx: number[] = []
    const by: number[] = []
    const si: number[] = []
    const sl: number[] = []
    let totalLen = 0
    items.forEach((it, idx) => {
      this.byId.set(it.id, idx)
      const pts = it.geometry.points
      if (pts.length === 1) {
        ax.push(pts[0].x), ay.push(pts[0].y), bx.push(pts[0].x), by.push(pts[0].y), si.push(idx), sl.push(0)
        return
      }
      const n = it.geometry.closed && pts.length > 2 ? pts.length : pts.length - 1
      for (let i = 0; i < n; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        ax.push(a.x), ay.push(a.y), bx.push(b.x), by.push(b.y), si.push(idx), sl.push(i)
        totalLen += Math.hypot(b.x - a.x, b.y - a.y)
      }
    })
    this.ax = Float64Array.from(ax)
    this.ay = Float64Array.from(ay)
    this.bx = Float64Array.from(bx)
    this.by = Float64Array.from(by)
    this.segItem = Int32Array.from(si)
    this.segLocal = Int32Array.from(sl)
    const mean = ax.length ? totalLen / ax.length : 30
    this.cellSize = opts.cellSize ?? Math.max(8, Math.min(120, mean || 30))
    this.itemStamp = new Int32Array(items.length)
    this.itemBest = new Float64Array(items.length)
    this.itemSeg = new Int32Array(items.length)
    this.itemPx = new Float64Array(items.length)
    this.itemPy = new Float64Array(items.length)
    for (let s = 0; s < ax.length; s++) this.insertSegment(s)
  }

  get segmentCount(): number {
    return this.ax.length
  }

  getItem(id: string): ContextItem | undefined {
    const i = this.byId.get(id)
    return i === undefined ? undefined : this.items[i]
  }

  /** Segment endpoints and owning item index (used by snap precompute). */
  segment(s: number): { a: Point; b: Point; itemIndex: number; local: number } {
    return {
      a: { x: this.ax[s], y: this.ay[s] },
      b: { x: this.bx[s], y: this.by[s] },
      itemIndex: this.segItem[s],
      local: this.segLocal[s],
    }
  }

  /** Calls cb for every pair of distinct segments that share a grid cell (each pair once). */
  forEachCandidatePair(cb: (i: number, j: number) => void): void {
    const seen = new Set<number>()
    const n = this.ax.length
    for (const list of this.grid.values()) {
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const i = Math.min(list[x], list[y])
          const j = Math.max(list[x], list[y])
          const k = i * n + j
          if (seen.has(k)) continue
          seen.add(k)
          cb(i, j)
        }
      }
    }
  }

  private add(cx: number, cy: number, s: number): void {
    if (cx < this.minCx) this.minCx = cx
    if (cx > this.maxCx) this.maxCx = cx
    if (cy < this.minCy) this.minCy = cy
    if (cy > this.maxCy) this.maxCy = cy
    const k = cellKey(cx, cy)
    const l = this.grid.get(k)
    if (l) l.push(s)
    else this.grid.set(k, [s])
  }

  private insertSegment(s: number): void {
    const cs = this.cellSize
    const ax = this.ax[s]
    const ay = this.ay[s]
    const bx = this.bx[s]
    const by = this.by[s]
    let cx = Math.floor(ax / cs)
    let cy = Math.floor(ay / cs)
    const ex = Math.floor(bx / cs)
    const ey = Math.floor(by / cs)
    const dx = bx - ax
    const dy = by - ay
    const stepX = dx > 0 ? 1 : -1
    const stepY = dy > 0 ? 1 : -1
    let tMaxX = dx !== 0 ? ((dx > 0 ? (cx + 1) * cs : cx * cs) - ax) / dx : Infinity
    let tMaxY = dy !== 0 ? ((dy > 0 ? (cy + 1) * cs : cy * cs) - ay) / dy : Infinity
    const tDx = dx !== 0 ? cs / Math.abs(dx) : Infinity
    const tDy = dy !== 0 ? cs / Math.abs(dy) : Infinity
    let guard = Math.abs(ex - cx) + Math.abs(ey - cy) + 2
    for (;;) {
      this.add(cx, cy, s)
      if ((cx === ex && cy === ey) || guard-- <= 0) break
      if (tMaxX < tMaxY) {
        cx += stepX
        tMaxX += tDx
      } else {
        cy += stepY
        tMaxY += tDy
      }
    }
  }

  private touch(item: number, s: number, d2: number, px: number, py: number): void {
    if (this.itemStamp[item] !== this.stamp) {
      this.itemStamp[item] = this.stamp
      this.itemBest[item] = d2
      this.itemSeg[item] = s
      return
    }
    if (d2 < this.itemBest[item]) {
      this.itemBest[item] = d2
      this.itemSeg[item] = s
    }
    void px
    void py
  }

  private hit(item: number, p: Point): ItemHit {
    const s = this.itemSeg[item]
    const c = closestPointOnSegment(p, { x: this.ax[s], y: this.ay[s] }, { x: this.bx[s], y: this.by[s] })
    return { item: this.items[item], distance: c.distance, point: c.point, segIndex: this.segLocal[s] }
  }

  /** All items with geometry within `radius` of `point`, nearest first. */
  itemsNear(point: Point, radius: number, filter?: (item: ContextItem) => boolean): ItemHit[] {
    const cs = this.cellSize
    this.stamp++
    const r2 = radius * radius
    const touched: number[] = []
    const x0 = Math.floor((point.x - radius) / cs)
    const x1 = Math.floor((point.x + radius) / cs)
    const y0 = Math.floor((point.y - radius) / cs)
    const y1 = Math.floor((point.y + radius) / cs)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.grid.get(cellKey(cx, cy))
        if (!list) continue
        for (let q = 0; q < list.length; q++) {
          const s = list[q]
          const item = this.segItem[s]
          const d2 = segmentDistance2(point.x, point.y, this.ax[s], this.ay[s], this.bx[s], this.by[s])
          if (d2 > r2) continue
          if (filter && this.itemStamp[item] !== this.stamp && !filter(this.items[item])) continue
          if (this.itemStamp[item] !== this.stamp) touched.push(item)
          this.touch(item, s, d2, 0, 0)
        }
      }
    }
    const out = touched.map((i) => this.hit(i, point))
    out.sort((a, b) => a.distance - b.distance)
    return out
  }

  /** Items having any segment touching the rect. */
  itemsInRect(rect: Rect, filter?: (item: ContextItem) => boolean): ContextItem[] {
    const cs = this.cellSize
    this.stamp++
    const out: ContextItem[] = []
    const x0 = Math.floor(rect.x / cs)
    const x1 = Math.floor((rect.x + rect.w) / cs)
    const y0 = Math.floor(rect.y / cs)
    const y1 = Math.floor((rect.y + rect.h) / cs)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.grid.get(cellKey(cx, cy))
        if (!list) continue
        for (const s of list) {
          const item = this.segItem[s]
          if (this.itemStamp[item] === this.stamp) continue
          if (segmentIntersectsRect({ x: this.ax[s], y: this.ay[s] }, { x: this.bx[s], y: this.by[s] }, rect)) {
            this.itemStamp[item] = this.stamp
            if (!filter || filter(this.items[item])) out.push(this.items[item])
          }
        }
      }
    }
    return out
  }

  /** The k nearest items (by distance to their geometry), nearest first. */
  nearest(point: Point, k: number, filter?: (item: ContextItem) => boolean): ItemHit[] {
    if (k <= 0 || this.ax.length === 0) return []
    const cs = this.cellSize
    this.stamp++
    const pcx = Math.floor(point.x / cs)
    const pcy = Math.floor(point.y / cs)
    const maxRing = Math.max(pcx - this.minCx, this.maxCx - pcx, pcy - this.minCy, this.maxCy - pcy, 0)
    const rejected = new Set<number>()
    const touched: number[] = []
    const visit = (cx: number, cy: number): void => {
      const list = this.grid.get(cellKey(cx, cy))
      if (!list) return
      for (let q = 0; q < list.length; q++) {
        const s = list[q]
        const item = this.segItem[s]
        if (rejected.has(item)) continue
        if (filter && this.itemStamp[item] !== this.stamp && !filter(this.items[item])) {
          rejected.add(item)
          continue
        }
        const d2 = segmentDistance2(point.x, point.y, this.ax[s], this.ay[s], this.bx[s], this.by[s])
        if (this.itemStamp[item] !== this.stamp) touched.push(item)
        this.touch(item, s, d2, 0, 0)
      }
    }
    for (let R = 0; R <= maxRing + 1; R++) {
      if (R === 0) visit(pcx, pcy)
      else {
        for (let d = -R; d <= R; d++) {
          visit(pcx + d, pcy - R)
          visit(pcx + d, pcy + R)
        }
        for (let d = -R + 1; d <= R - 1; d++) {
          visit(pcx - R, pcy + d)
          visit(pcx + R, pcy + d)
        }
      }
      if (touched.length >= k) {
        const bests = touched.map((i) => this.itemBest[i]).sort((a, b) => a - b)
        const kth = Math.sqrt(bests[k - 1])
        if (kth <= R * cs) break
      }
    }
    touched.sort((a, b) => this.itemBest[a] - this.itemBest[b] || a - b)
    return touched.slice(0, k).map((i) => this.hit(i, point))
  }
}

/** Simple hashed point grid for snap targets. */
export class PointGrid<T> {
  private cells = new Map<number, { p: Point; v: T }[]>()
  constructor(readonly cellSize: number) {}
  insert(p: Point, v: T): void {
    const k = cellKey(Math.floor(p.x / this.cellSize), Math.floor(p.y / this.cellSize))
    const l = this.cells.get(k)
    if (l) l.push({ p, v })
    else this.cells.set(k, [{ p, v }])
  }
  query(center: Point, radius: number): { p: Point; v: T; distance: number }[] {
    const cs = this.cellSize
    const out: { p: Point; v: T; distance: number }[] = []
    for (let cx = Math.floor((center.x - radius) / cs); cx <= Math.floor((center.x + radius) / cs); cx++) {
      for (let cy = Math.floor((center.y - radius) / cs); cy <= Math.floor((center.y + radius) / cs); cy++) {
        const l = this.cells.get(cellKey(cx, cy))
        if (!l) continue
        for (const e of l) {
          const d = Math.hypot(e.p.x - center.x, e.p.y - center.y)
          if (d <= radius) out.push({ p: e.p, v: e.v, distance: d })
        }
      }
    }
    return out
  }
}

export function buildSpatialIndex(items: readonly ContextItem[], opts?: SpatialOptions): SpatialIndex {
  return new SpatialIndex(items, opts)
}
