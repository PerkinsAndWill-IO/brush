/**
 * Board layout and coordinate transforms. PURE: no DOM, no React — unit
 * tested in tests/unit/app-layout.test.ts.
 *
 * Three spaces:
 *  - sheet:  PDF points of one sheet, origin top-left, y down (core/types).
 *  - board:  one shared plane; 1 board unit = 1 PDF point. Each sheet is a
 *            rectangle placed at (x, y) on it.
 *  - screen: CSS pixels relative to the viewport element's top-left.
 *
 * Camera (same convention as tldraw): screen = (board + cam.xy) * cam.z.
 */
import type { Point, Rect, Sheet } from '@core/types'

export interface Camera {
  x: number
  y: number
  z: number
}

export interface Placement {
  sheetId: string
  pageIndex: number
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutOptions {
  /** Columns; default ceil(sqrt(n)) (6 sheets → 3 × 2, as in the design). */
  columns?: number
  /** Horizontal gap between sheets, board units. */
  gapX?: number
  /** Vertical gap between rows, board units (room for the name label above each sheet). */
  gapY?: number
}

export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 24

/** Lay sheets out in a grid, row-major in page order. Cells are sized by the largest sheet in their column/row. */
export function layoutSheets(sheets: readonly Pick<Sheet, 'id' | 'pageIndex' | 'sizePt'>[], opts: LayoutOptions = {}): Placement[] {
  const n = sheets.length
  if (n === 0) return []
  const cols = Math.max(1, Math.min(n, opts.columns ?? Math.ceil(Math.sqrt(n))))
  const rows = Math.ceil(n / cols)
  const maxW = Math.max(...sheets.map((s) => s.sizePt.w))
  const gapX = opts.gapX ?? Math.round(maxW * 0.12)
  const gapY = opts.gapY ?? Math.round(maxW * 0.14)
  const colW: number[] = new Array(cols).fill(0)
  const rowH: number[] = new Array(rows).fill(0)
  sheets.forEach((s, i) => {
    colW[i % cols] = Math.max(colW[i % cols], s.sizePt.w)
    rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], s.sizePt.h)
  })
  const colX = colW.map((_, c) => colW.slice(0, c).reduce((a, b) => a + b + gapX, 0))
  const rowY = rowH.map((_, r) => rowH.slice(0, r).reduce((a, b) => a + b + gapY, 0))
  return sheets.map((s, i) => ({
    sheetId: s.id,
    pageIndex: s.pageIndex,
    x: colX[i % cols],
    y: rowY[Math.floor(i / cols)],
    w: s.sizePt.w,
    h: s.sizePt.h,
  }))
}

export function boardBounds(placements: readonly Placement[]): Rect {
  if (placements.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const x0 = Math.min(...placements.map((p) => p.x))
  const y0 = Math.min(...placements.map((p) => p.y))
  const x1 = Math.max(...placements.map((p) => p.x + p.w))
  const y1 = Math.max(...placements.map((p) => p.y + p.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ───────────── transforms ─────────────

export const sheetToBoard = (pl: Placement, p: Point): Point => ({ x: p.x + pl.x, y: p.y + pl.y })
export const boardToSheet = (pl: Placement, p: Point): Point => ({ x: p.x - pl.x, y: p.y - pl.y })
export const boardToScreen = (cam: Camera, p: Point): Point => ({ x: (p.x + cam.x) * cam.z, y: (p.y + cam.y) * cam.z })
export const screenToBoard = (cam: Camera, p: Point): Point => ({ x: p.x / cam.z - cam.x, y: p.y / cam.z - cam.y })
export const sheetToScreen = (cam: Camera, pl: Placement, p: Point): Point => boardToScreen(cam, sheetToBoard(pl, p))
export const screenToSheet = (cam: Camera, pl: Placement, p: Point): Point => boardToSheet(pl, screenToBoard(cam, p))

export function containsBoardPoint(pl: Placement, p: Point): boolean {
  return p.x >= pl.x && p.x <= pl.x + pl.w && p.y >= pl.y && p.y <= pl.y + pl.h
}

/** The sheet under a board point, or null (ink there is discarded, M1-07). Later sheets win on overlap. */
export function sheetAt(placements: readonly Placement[], p: Point): Placement | null {
  for (let i = placements.length - 1; i >= 0; i--) if (containsBoardPoint(placements[i], p)) return placements[i]
  return null
}

// ───────────── camera ─────────────

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

/** Zoom to `z`, keeping the board point under `screenPt` fixed (zoom centered on the pointer, M1-04). */
export function zoomAt(cam: Camera, screenPt: Point, z: number): Camera {
  const nz = clampZoom(z)
  const b = screenToBoard(cam, screenPt)
  return { x: screenPt.x / nz - b.x, y: screenPt.y / nz - b.y, z: nz }
}

/** Pan by a screen-space delta. */
export const panBy = (cam: Camera, dxScreen: number, dyScreen: number): Camera => ({
  x: cam.x + dxScreen / cam.z,
  y: cam.y + dyScreen / cam.z,
  z: cam.z,
})

/**
 * Camera that fits `rect` (board units) into a viewport of `vw × vh` px with `pad` px margin, centered. A side that
 * does not fit even at the minimum zoom shows its start (left, top: where the first sheet is) instead of its middle.
 */
export function fitCamera(rect: Rect, vw: number, vh: number, pad = 48, maxZ = 1): Camera {
  if (rect.w <= 0 || rect.h <= 0 || vw <= 0 || vh <= 0) return { x: 0, y: 0, z: 1 }
  const z = clampZoom(Math.min((vw - 2 * pad) / rect.w, (vh - 2 * pad) / rect.h, maxZ))
  const at = (start: number, size: number, view: number) => (size * z > view - 2 * pad ? pad / z - start : view / 2 / z - (start + size / 2))
  return { x: at(rect.x, rect.w, vw), y: at(rect.y, rect.h, vh), z }
}

/** Board-space rectangle visible in a `vw × vh` viewport. */
export function visibleBoardRect(cam: Camera, vw: number, vh: number): Rect {
  const a = screenToBoard(cam, { x: 0, y: 0 })
  return { x: a.x, y: a.y, w: vw / cam.z, h: vh / cam.z }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Page raster scale (device px per PDF point) a sheet should have at zoom `z`
 * (M1-05). Quantized to powers of two so small zoom changes don't re-render,
 * always >= z * dpr (sharp) unless capped by `maxPixels` (memory guard).
 */
export function renderScaleFor(z: number, dpr: number, sizePt: { w: number; h: number }, maxPixels = 4096 * 4096): number {
  const want = Math.max(0.5, Math.pow(2, Math.ceil(Math.log2(Math.max(1e-6, z * dpr)) - 1e-9)))
  const cap = Math.sqrt(maxPixels / Math.max(1, sizePt.w * sizePt.h))
  return Math.min(want, cap)
}

/** Detail raster: the part of a sheet to render sharp on top of a capped page raster, and its scale. */
export interface DetailRegion {
  /** Device px per sheet point (exactly z * dpr, so it maps 1:1 to screen pixels). */
  scale: number
  /** Sheet points, snapped to the detail raster's pixel grid. */
  rect: Rect
}

/**
 * When the whole-page raster (`baseScale`, capped by its pixel budget) is coarser than the screen at zoom `cam.z`,
 * the visible part of the sheet (plus `margin` of a viewport on each side, so small pans stay sharp) is rendered
 * again at full resolution. Null when the page raster is already sharp or the sheet is off screen.
 */
export function detailRegionFor(
  cam: Camera,
  vw: number,
  vh: number,
  placement: Placement,
  dpr: number,
  baseScale: number,
  margin = 0.25,
  maxPixels = 4096 * 4096,
): DetailRegion | null {
  let scale = cam.z * dpr
  if (scale <= baseScale * 1.01 || vw <= 0 || vh <= 0) return null
  const vis = visibleBoardRect(cam, vw, vh)
  const region = (m: number): Rect | null => {
    const x0 = Math.max(placement.x, vis.x - vis.w * m)
    const y0 = Math.max(placement.y, vis.y - vis.h * m)
    const x1 = Math.min(placement.x + placement.w, vis.x + vis.w * (1 + m))
    const y1 = Math.min(placement.y + placement.h, vis.y + vis.h * (1 + m))
    return x1 > x0 && y1 > y0 ? { x: x0 - placement.x, y: y0 - placement.y, w: x1 - x0, h: y1 - y0 } : null
  }
  let r = region(margin)
  if (!r) return null
  if (r.w * r.h * scale * scale > maxPixels) r = region(0)!
  if (r.w * r.h * scale * scale > maxPixels) {
    scale = Math.sqrt(maxPixels / (r.w * r.h))
    if (scale <= baseScale * 1.01) return null
  }
  // snap to the raster's pixel grid so the canvas lines up with whole device pixels
  const px0 = Math.floor(r.x * scale)
  const py0 = Math.floor(r.y * scale)
  const px1 = Math.min(Math.ceil((r.x + r.w) * scale), Math.floor(placement.w * scale))
  const py1 = Math.min(Math.ceil((r.y + r.h) * scale), Math.floor(placement.h * scale))
  if (px1 <= px0 || py1 <= py0) return null
  return { scale, rect: { x: px0 / scale, y: py0 / scale, w: (px1 - px0) / scale, h: (py1 - py0) / scale } }
}
