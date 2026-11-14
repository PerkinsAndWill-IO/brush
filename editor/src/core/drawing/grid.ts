/**
 * Uniform grid over primitives numbered 0..n-1, in compressed (CSR) layout: the caller says which cells each one
 * touches. Port of the schema viewer's grid (`schema/src/grid.ts`), which is what makes picking cheap on sheets
 * with millions of segments.
 */
export type EmitCell = (col: number, row: number) => void

/** A fill yields after this many primitives (16384), about 3 ms of work. */
const YIELD_MASK = 0x3fff

export class Grid {
  readonly cols: number
  readonly rows: number
  private readonly cw: number
  private readonly ch: number
  private start = new Int32Array(1)
  private ids = new Int32Array(0)
  private seen = new Int32Array(0)
  private gen = 0

  /** `expected` is the number of primitives; the cell size aims at a handful of them per cell. */
  constructor(
    readonly minX: number,
    readonly minY: number,
    maxX: number,
    maxY: number,
    expected: number,
    perCell = 4,
  ) {
    const w = Math.max(maxX - minX, 1e-9)
    const h = Math.max(maxY - minY, 1e-9)
    const targetCells = Math.min(250_000, Math.max(1, Math.ceil(expected / perCell)))
    const side = Math.sqrt((w * h) / targetCells)
    this.cols = Math.min(1024, Math.max(1, Math.ceil(w / side)))
    this.rows = Math.min(1024, Math.max(1, Math.ceil(h / side)))
    this.cw = w / this.cols
    this.ch = h / this.rows
  }

  col(x: number): number {
    const c = Math.floor((x - this.minX) / this.cw)
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c
  }

  row(y: number): number {
    const r = Math.floor((y - this.minY) / this.ch)
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r
  }

  /** Number of cells a bounding box covers. */
  boxCellCount(x0: number, y0: number, x1: number, y1: number): number {
    return (this.col(x1) - this.col(x0) + 1) * (this.row(y1) - this.row(y0) + 1)
  }

  cellsOfBox(x0: number, y0: number, x1: number, y1: number, emit: EmitCell): void {
    const c1 = this.col(x1)
    const r1 = this.row(y1)
    for (let r = this.row(y0); r <= r1; r++) for (let c = this.col(x0); c <= c1; c++) emit(c, r)
  }

  /** Only the cells the segment really crosses, not its whole bounding box. */
  cellsOfSegment(ax: number, ay: number, bx: number, by: number, emit: EmitCell): void {
    const c0 = this.col(Math.min(ax, bx))
    const c1 = this.col(Math.max(ax, bx))
    const r0 = this.row(Math.min(ay, by))
    const r1 = this.row(Math.max(ay, by))
    if ((c1 - c0 + 1) * (r1 - r0 + 1) <= 4) {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) emit(c, r)
      return
    }
    const dx = bx - ax
    const dy = by - ay
    for (let r = r0; r <= r1; r++) {
      const y0 = this.minY + r * this.ch
      const y1 = y0 + this.ch
      for (let c = c0; c <= c1; c++) {
        const x0 = this.minX + c * this.cw
        const x1 = x0 + this.cw
        // the line misses the cell when all four corners lie strictly on one side of it
        const s00 = dx * (y0 - ay) - dy * (x0 - ax)
        const s10 = dx * (y0 - ay) - dy * (x1 - ax)
        const s01 = dx * (y1 - ay) - dy * (x0 - ax)
        const s11 = dx * (y1 - ay) - dy * (x1 - ax)
        if ((s00 > 0 && s10 > 0 && s01 > 0 && s11 > 0) || (s00 < 0 && s10 < 0 && s01 < 0 && s11 < 0)) continue
        emit(c, r)
      }
    }
  }

  /**
   * `cellsFor` is called twice per primitive (count pass, then fill pass) and must emit the same cells both times.
   * A generator that yields every 16384 primitives, so a caller can spread a big fill over several frames.
   */
  *fill(n: number, cellsFor: (prim: number, emit: EmitCell) => void): Generator<void> {
    const cells = this.cols * this.rows
    const start = new Int32Array(cells + 1)
    let prim = 0
    const count: EmitCell = (c, r) => {
      start[r * this.cols + c + 1]++
    }
    for (prim = 0; prim < n; prim++) {
      cellsFor(prim, count)
      if ((prim & YIELD_MASK) === YIELD_MASK) yield
    }
    for (let i = 0; i < cells; i++) start[i + 1] += start[i]
    const ids = new Int32Array(start[cells])
    const next = start.slice(0, cells)
    const put: EmitCell = (c, r) => {
      ids[next[r * this.cols + c]++] = prim
    }
    for (prim = 0; prim < n; prim++) {
      cellsFor(prim, put)
      if ((prim & YIELD_MASK) === YIELD_MASK) yield
    }
    this.start = start
    this.ids = ids
    this.seen = new Int32Array(n)
    this.gen = 0
  }

  /** Calls visit once per primitive registered in any cell touched by the box. */
  query(x0: number, y0: number, x1: number, y1: number, visit: (prim: number) => void): void {
    if (x1 < this.minX || y1 < this.minY || x0 > this.minX + this.cw * this.cols || y0 > this.minY + this.ch * this.rows) return
    const gen = ++this.gen
    const c1 = this.col(x1)
    const r1 = this.row(y1)
    for (let r = this.row(y0); r <= r1; r++) {
      for (let c = this.col(x0); c <= c1; c++) {
        const cell = r * this.cols + c
        for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
          const p = this.ids[k]
          if (this.seen[p] === gen) continue
          this.seen[p] = gen
          visit(p)
        }
      }
    }
  }
}
