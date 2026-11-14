/** Uniform-grid spatial hash over axis-aligned boxes. Ids must be < capacity. */
export class SpatialHash {
  private cells = new Map<number, number[]>()
  private big: number[] = []
  private stamp: Int32Array
  private cur = 0
  constructor(
    readonly cell: number,
    capacity: number,
  ) {
    this.stamp = new Int32Array(capacity)
  }
  private key(cx: number, cy: number): number {
    const x = Math.max(-4999, Math.min(14999, cx))
    const y = Math.max(-4999, Math.min(14999, cy))
    return (x + 5000) * 20000 + (y + 5000)
  }
  insert(id: number, minX: number, minY: number, maxX: number, maxY: number): void {
    const c = this.cell
    const x0 = Math.floor(minX / c)
    const x1 = Math.floor(maxX / c)
    const y0 = Math.floor(minY / c)
    const y1 = Math.floor(maxY / c)
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      this.big.push(id)
      return
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y)
        const l = this.cells.get(k)
        if (l) l.push(id)
        else this.cells.set(k, [id])
      }
  }
  /** Unique ids whose cells overlap the box (candidates, not exact). Sorted ascending unless `sorted` is false. */
  query(minX: number, minY: number, maxX: number, maxY: number, out: number[], sorted = true): number[] {
    out.length = 0
    this.cur++
    const st = this.stamp
    const cur = this.cur
    for (const id of this.big) {
      st[id] = cur
      out.push(id)
    }
    const c = this.cell
    const x0 = Math.floor(minX / c)
    const x1 = Math.floor(maxX / c)
    const y0 = Math.floor(minY / c)
    const y1 = Math.floor(maxY / c)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const l = this.cells.get(this.key(x, y))
        if (!l) continue
        for (const id of l)
          if (st[id] !== cur) {
            st[id] = cur
            out.push(id)
          }
      }
    if (sorted && out.length > 1) out.sort((a, b) => a - b)
    return out
  }
}
