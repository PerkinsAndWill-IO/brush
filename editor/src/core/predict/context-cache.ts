import type { ContextItem, Rect, SheetContext } from '../types'
import { SpatialIndex, bbox } from '../geometry'
import { sheetInfo, type SheetType } from '../context'

/**
 * Drawing convention the brush reads strokes in, from the sheet type:
 * - 'plan' (plans, and sheets of unknown type): walls, door ticks and swings, furniture.
 * - 'elevation' (elevations and sections): openings are upright outlines seen face on.
 * - 'detail' (details, axonometrics, schedules / legends / covers): no element reading at all; plan walls, doors and
 *   furniture make no sense at a detail's scale or in a 3D view, so the sketch stays ink (markup) or erases.
 */
export type ViewMode = 'plan' | 'elevation' | 'detail'

export function viewModeOf(t: SheetType | undefined): ViewMode {
  if (t === 'elevation' || t === 'section') return 'elevation'
  if (t === 'detail' || t === 'axonometric' || t === 'other') return 'detail'
  return 'plan'
}

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
  /** Sheet type from the context's sheet-info item ('unknown' when it has none). */
  sheetType: SheetType
  view: ViewMode
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
    sheetType: 'unknown',
    view: 'plan',
  }
  p.sheetType = sheetInfo(ctx)?.sheetType ?? 'unknown'
  p.view = viewModeOf(p.sheetType)
  if (ctx.scale && ctx.scale > 0) p.ptPerM = ptPerMetre(ctx.scale)
  cache.set(ctx, p)
  return p
}
