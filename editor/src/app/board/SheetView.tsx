/**
 * One sheet on the board: name label above, the pdf.js page raster, the ink
 * layer and the overlay layer. Both SVG layers use the sheet's own
 * coordinates (viewBox = PDF points), so strokes are drawn exactly as stored.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import type { Sheet, Stroke } from '@core/types'
import { getCamera, onCameraSettled } from '../camera'
import type { PageRenderer } from '../source'
import { notifyPageRendered } from '../store'
import { inkRender, type InkRender } from './ink'
import { rectsIntersect, renderScaleFor, visibleBoardRect, type Placement } from './layout'
import { ContextBadge } from '../brain/overlays'
import { penGate } from './penGate'
import { SheetGrid } from './viewAidLayers'
import { enqueueRender } from './renderQueue'
import { useFilters } from '../drawing/filters'

// ───────────── layer registry (board input writes wet ink here) ─────────────

export interface SheetLayers {
  ink: SVGSVGElement
  wet: SVGPathElement
  overlay: SVGSVGElement
  grid: SVGSVGElement
}
const layers = new Map<string, SheetLayers>()
export const getSheetLayers = (sheetId: string): SheetLayers | undefined => layers.get(sheetId)

/**
 * Keep --z live on the grid and overlay layers only (V1-05), so screen-constant
 * marks and labels stay the same size during a zoom instead of jumping when it
 * settles. The rest of the world (paper shadows, sheet names) updates on settle.
 */
export function setLiveZoom(z: number) {
  const v = String(z)
  for (const l of layers.values()) {
    l.overlay.style.setProperty('--z', v)
    l.grid.style.setProperty('--z', v)
  }
}

// ───────────── overlay extension point (M2 snap markers, M3 ghost + chips) ─────────────

/** Rendered inside each sheet's overlay <svg>, in sheet points. */
export type SheetOverlay = ComponentType<{ sheet: Sheet; placement: Placement }>
const overlays = new Set<SheetOverlay>()
const overlayListeners = new Set<() => void>()
export function registerSheetOverlay(c: SheetOverlay): () => void {
  overlays.add(c)
  overlayListeners.forEach((l) => l())
  return () => {
    overlays.delete(c)
    overlayListeners.forEach((l) => l())
  }
}
function useOverlays(): SheetOverlay[] {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    overlayListeners.add(l)
    return () => void overlayListeners.delete(l)
  }, [])
  return [...overlays]
}

// ───────────── ink rendering ─────────────

const renderCache = new WeakMap<Stroke, InkRender>()
/** Render data for a committed stroke. Smoothing is fixed when first rendered (at commit). */
export function cachedInk(stroke: Stroke, smoothing: number, precomputed?: InkRender): InkRender {
  let r = renderCache.get(stroke)
  if (!r) {
    r = precomputed ?? inkRender(stroke.points, stroke.size, smoothing)
    renderCache.set(stroke, r)
  }
  return r
}

const pathCache = new WeakMap<Stroke, Path2D>()

/** Draw strokes (sheet pts) into a 2D context already scaled to sheet points. */
export function drawStrokes(g: CanvasRenderingContext2D, strokes: readonly Stroke[], smoothing: number, faded?: ReadonlySet<string>) {
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const s of strokes) {
    if (s.tool === 'eraser') continue // an eraser pass kept as the source of a delete element: no ink
    // ink of a committed element stays visible underneath it, faded (undo brings it back fully)
    g.globalAlpha = faded?.has(s.id) ? 0.28 : 1
    const r = cachedInk(s, smoothing)
    let p = pathCache.get(s)
    if (!p) pathCache.set(s, (p = new Path2D(r.d)))
    if (r.mode === 'stroke') {
      g.strokeStyle = s.color ?? '#D7263D'
      g.lineWidth = r.width
      g.stroke(p)
    } else {
      g.fillStyle = s.color ?? '#D7263D'
      g.fill(p)
    }
  }
}

// ───────────── the sheet ─────────────

interface Props {
  sheet: Sheet
  placement: Placement
  pages?: PageRenderer
  loadId: number
  strokes: readonly Stroke[]
  /** Strokes that became elements (M3): their ink is drawn faded. */
  faded: ReadonlySet<string>
  smoothing: number
  active: boolean
  viewport: () => { w: number; h: number }
}

export const SheetView = memo(function SheetView({ sheet, placement, pages, loadId, strokes, faded, smoothing, active, viewport }: Props) {
  const pageRef = useRef<HTMLDivElement>(null)
  const inkRef = useRef<SVGSVGElement>(null)
  const inkCanvasRef = useRef<HTMLCanvasElement>(null)
  const drawn = useRef<{ strokes: readonly Stroke[]; scale: number; faded?: ReadonlySet<string> }>({ strokes: [], scale: 0 })
  const [inkScale, setInkScale] = useState(0)
  const wetRef = useRef<SVGPathElement>(null)
  const overlayRef = useRef<SVGSVGElement>(null)
  const gridRef = useRef<SVGSVGElement>(null)
  const [renderScale, setRenderScale] = useState(0)
  // Display filters (V2) change what a `.drawing` page draws: re-render on a change. The old raster stays until then.
  const filterVersion = useFilters().version
  const [renderedFilter, setRenderedFilter] = useState(-1)
  const overlayComponents = useOverlays()

  useLayoutEffect(() => {
    if (!inkRef.current || !wetRef.current || !overlayRef.current || !gridRef.current) return
    layers.set(sheet.id, { ink: inkRef.current, wet: wetRef.current, overlay: overlayRef.current, grid: gridRef.current })
    const z = String(getCamera().z)
    overlayRef.current.style.setProperty('--z', z)
    gridRef.current.style.setProperty('--z', z)
    return () => void layers.delete(sheet.id)
  }, [sheet.id])

  // Page raster: first render, then again whenever the camera settles at a zoom needing another resolution (M1-05).
  useEffect(() => {
    let current = 0
    let first = true
    const key = `${loadId}:${sheet.id}`
    const request = () => {
      if (!pages) {
        // package without a PDF: blank paper, nothing to render
        if (first) {
          first = false
          current = 1
          setRenderScale(1)
          notifyPageRendered(loadId, sheet.pageIndex)
        }
        return
      }
      const cam = getCamera()
      const vp = viewport()
      const visible = rectsIntersect(visibleBoardRect(cam, vp.w, vp.h), placement)
      const dpr = window.devicePixelRatio || 1
      const target = renderScaleFor(cam.z, dpr, sheet.sizePt)
      // Off-screen sheets are not upgraded (memory); they are re-rendered when they come into view and the camera settles.
      if (target === current || (!first && !visible && target > current)) return
      const priority = (visible ? 0 : 1000) + sheet.pageIndex
      enqueueRender(key, priority, async (signal) => {
        const canvas = document.createElement('canvas')
        await pages.render(sheet.pageIndex, canvas, target, signal, penGate)
        if (signal.aborted || !pageRef.current) return
        pageRef.current.replaceChildren(canvas)
        current = target
        setRenderScale(target)
        setRenderedFilter(filterVersion)
        if (first) {
          first = false
          notifyPageRendered(loadId, sheet.pageIndex)
        }
      }).catch((e) => {
        if ((e as Error)?.name !== 'AbortError' && !/cancel/i.test(String((e as Error)?.message))) console.error('render failed', e)
      })
    }
    request()
    const off = onCameraSettled(request)
    return () => off()
  }, [pages, sheet, placement, loadId, viewport, filterVersion])

  // Ink raster scale follows the camera like the page does (sharp after zoom settles), but synchronously.
  useEffect(() => {
    const update = () => {
      const cam = getCamera()
      const vp = viewport()
      const visible = rectsIntersect(visibleBoardRect(cam, vp.w, vp.h), placement)
      const target = renderScaleFor(cam.z, window.devicePixelRatio || 1, sheet.sizePt)
      setInkScale((cur) => (cur === 0 || visible || target < cur ? target : cur))
    }
    update()
    return onCameraSettled(update)
  }, [sheet, placement, viewport])

  // Committed ink: append-only changes draw just the new strokes; anything else (undo, erase, rescale) redraws.
  useLayoutEffect(() => {
    const c = inkCanvasRef.current
    if (!c || inkScale === 0) return
    const prev = drawn.current
    const g = c.getContext('2d')!
    const appended = prev.scale === inkScale && prev.faded === faded && prev.strokes.length <= strokes.length && prev.strokes.every((s, i) => strokes[i] === s)
    if (!appended) {
      c.width = Math.max(1, Math.floor(sheet.sizePt.w * inkScale))
      c.height = Math.max(1, Math.floor(sheet.sizePt.h * inkScale))
    }
    g.setTransform(inkScale, 0, 0, inkScale, 0, 0)
    drawStrokes(g, appended ? strokes.slice(prev.strokes.length) : strokes, smoothing, faded)
    drawn.current = { strokes, scale: inkScale, faded }
  }, [strokes, faded, inkScale, smoothing, sheet.sizePt])

  const { w, h } = sheet.sizePt
  return (
    <div
      className={`sheet${active ? ' active' : ''}`}
      data-testid="sheet"
      data-sheet-id={sheet.id}
      data-rendered={renderScale > 0}
      data-render-scale={renderScale}
      data-filter-version={renderedFilter}
      style={{ left: placement.x, top: placement.y, width: placement.w, height: placement.h }}
    >
      <div className="sheet-label" data-testid="sheet-label">
        {active && <span className="dot" aria-hidden="true" />}
        {sheet.number && <span className="num">{sheet.number}</span>}
        {sheet.name !== sheet.number && <span className="name">{sheet.name}</span>}
        <ContextBadge sheetId={sheet.id} />
      </div>
      <div className="paper">
        <div className="page" ref={pageRef} />
        {renderScale === 0 && <div className="placeholder" aria-label="Loading sheet" />}
        <svg className="grid" ref={gridRef} viewBox={`0 0 ${w} ${h}`} width={w} height={h} data-layer="grid" aria-hidden="true">
          <SheetGrid sheet={sheet} />
        </svg>
        <canvas className="ink-canvas" ref={inkCanvasRef} data-layer="ink" data-ink-count={strokes.filter((s) => s.tool !== 'eraser').length} data-ink-scale={inkScale} />
        <svg className="ink" ref={inkRef} viewBox={`0 0 ${w} ${h}`} width={w} height={h} data-layer="wet-ink">
          <path ref={wetRef} className="wet" data-layer="wet" />
        </svg>
        <svg className="overlay" ref={overlayRef} viewBox={`0 0 ${w} ${h}`} width={w} height={h} data-layer="overlay">
          {overlayComponents.map((C, i) => (
            <C key={i} sheet={sheet} placement={placement} />
          ))}
        </svg>
      </div>
    </div>
  )
})
