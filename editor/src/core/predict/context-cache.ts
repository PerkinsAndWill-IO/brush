import type { ContextItem, Rect, SheetContext } from '../types'
import { SpatialIndex, bbox } from '../geometry'

/**
 * Per-SheetContext precomputation (spatial indexes, rooms, labels), cached by
 * object identity so the 50 ms refresh never rebuilds it. Pure: the cache is
 * a WeakMap keyed by the context object, so results only depend on its content.
 */
export interface PreparedContext {
  ctx: SheetContext
  /** Everything, for nearest-k queries (context packet). */
  all: SpatialIndex
  /** Walls and grids: snapping, alignment, crossings. */
  lines: SpatialIndex
  /** Walls only. */
  walls: ContextItem[]
  /** Detected fixtures / furniture (delete targets). */
  fixtures: { item: ContextItem; box: Rect }[]
  labels: { item: ContextItem; box: Rect }[]
  /** True when the context carries no usable items (scanned sheet / shape only). */
  shapeOnly: boolean
  /** Sheet points per real metre; undefined when the scale is unknown. */
  ptPerM?: number
}

const cache = new WeakMap<SheetContext, PreparedContext>()

/** 1 m at 1:scale in sheet points: 1000 mm / scale / 25.4 mm per in * 72 pt per in. */
export const ptPerMetre = (scale: number): number => (1000 / scale / 25.4) * 72

export function prepareContext(ctx: SheetContext): PreparedContext {
  const hit = cache.get(ctx)
  if (hit) return hit
  const items = ctx.items ?? []
  const lineItems = items.filter((i) => i.kind === 'wall' || i.kind === 'grid')
  const p: PreparedContext = {
    ctx,
    all: new SpatialIndex(items),
    lines: new SpatialIndex(lineItems),
    walls: items.filter((i) => i.kind === 'wall'),
    fixtures: items.filter((i) => i.kind === 'fixture').map((item) => ({ item, box: bbox(item.geometry.points) })),
    labels: items.filter((i) => i.kind === 'label' && !!i.text).map((item) => ({ item, box: bbox(item.geometry.points) })),
    shapeOnly: !!ctx.shapeOnly || items.length === 0,
  }
  if (ctx.scale && ctx.scale > 0) p.ptPerM = ptPerMetre(ctx.scale)
  cache.set(ctx, p)
  return p
}
