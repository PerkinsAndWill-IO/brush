/**
 * View aids on the board (docs/tasks/V1-view-aids.md), ported from the chSpace viewer:
 *  - SheetGrid       (V1-03): metric grid under the ink, on sheets whose scale is known
 *  - MeasureOverlay  (V1-02): Measure tool lines with real-unit labels, in sheet points
 *  - ScaleBarHud     (V1-01): graphic scale for the sheet in the middle of the viewport
 * On-board sizes divide by --z (kept live on these layers by the board); text also
 * multiplies by --label-scale (V1-04).
 */
import { memo, useMemo, useSyncExternalStore } from 'react'
import type { Point, Sheet } from '@core/types'
import { snapPoint } from '@core/geometry'
import { prepareContext } from '@core/predict'
import { contextNow, useContexts } from '../brain/contextStore'
import { getCamera, subscribeCamera, useSettledZoom } from '../camera'
import { getSession } from '../session'
import { getDocState } from '../store'
import { sheetScale, useView, type Measurement } from '../view'
import { rectsIntersect, screenToBoard, sheetAt, visibleBoardRect, type Placement } from './layout'
import { formatMetres, gridLines, gridSpacingFor, scaleBarFor, sheetDistanceMetres } from './viewAids'

const px = (n: number) => `calc(${n}px / var(--z))`
const textPx = (n: number) => `calc(${n}px * var(--label-scale, 1) / var(--z))`

function useSheetScale(sheet: Sheet): number | undefined {
  const { contexts } = useContexts()
  return sheet.scale ?? contexts.get(sheet.id)?.scale
}

// ───────────── grid (V1-03) ─────────────

/** Grid lines for one sheet. Spacing adapts to the zoom when the camera settles. */
export const SheetGrid = memo(function SheetGrid({ sheet }: { sheet: Sheet }) {
  const { grid } = useView()
  const z = useSettledZoom()
  const scale = useSheetScale(sheet)
  const { w, h } = sheet.sizePt
  const spacing = grid ? gridSpacingFor(z, scale, Math.max(w, h)) : null
  const minorPt = spacing?.minorPt
  const majorPt = spacing?.majorPt
  const d = useMemo(() => {
    if (!minorPt || !majorPt) return null
    const minor: string[] = []
    const major: string[] = []
    const ratio = Math.round(majorPt / minorPt)
    gridLines(w, minorPt).forEach((x, i) => (i % ratio === 0 ? major : minor).push(`M${x} 0V${h}`))
    gridLines(h, minorPt).forEach((y, i) => (i % ratio === 0 ? major : minor).push(`M0 ${y}H${w}`))
    return { minor: minor.join(''), major: major.join('') }
  }, [minorPt, majorPt, w, h])
  if (!spacing || !d) return null
  return (
    <g data-testid="sheet-grid" data-minor-m={spacing.minorM} data-major-m={spacing.majorM}>
      <path d={d.minor} fill="none" stroke="rgba(70, 78, 84, 0.16)" style={{ strokeWidth: px(1) }} />
      <path d={d.major} fill="none" stroke="rgba(55, 62, 68, 0.3)" style={{ strokeWidth: px(1) }} />
    </g>
  )
})

// ───────────── measurements (V1-02) ─────────────

function MeasureLine({ m, scale, draft }: { m: Measurement; scale: number | undefined; draft?: boolean }) {
  const len = scale ? sheetDistanceMetres(m.a, m.b, scale) : undefined
  const label = len !== undefined ? formatMetres(len) : `${Math.round(Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y))} pt · no scale`
  const mid = { x: (m.a.x + m.b.x) / 2, y: (m.a.y + m.b.y) / 2 }
  return (
    <g className={`measure${draft ? ' draft' : ''}`} data-testid={draft ? 'measurement-draft' : 'measurement'} data-measure-id={m.id} data-metres={len} data-label={label}>
      <path d={`M${m.a.x} ${m.a.y}L${m.b.x} ${m.b.y}`} style={{ strokeWidth: px(2) }} />
      {[m.a, m.b].map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} style={{ r: px(3.5), strokeWidth: px(1.6) }} />
      ))}
      <text x={mid.x} y={mid.y} dy="-0.7em" textAnchor="middle" style={{ fontSize: textPx(12), strokeWidth: px(3.5) }}>
        {label}
      </text>
    </g>
  )
}

export function MeasureOverlay({ sheet }: { sheet: Sheet; placement: Placement }) {
  const { measurements, draft } = useView()
  const scale = useSheetScale(sheet)
  const mine = measurements.filter((m) => m.sheetId === sheet.id)
  const d = draft?.sheetId === sheet.id ? draft : null
  if (!mine.length && !d) return null
  return (
    <g data-layer="measurements">
      {mine.map((m) => (
        <MeasureLine key={m.id} m={m} scale={scale} />
      ))}
      {d && <MeasureLine m={d} scale={scale} draft />}
    </g>
  )
}

/** Snap a measure endpoint (sheet pts) to walls and grid lines, when snapping is on. */
export function snapMeasurePoint(sheetId: string, p: Point): Point {
  const { settings } = getSession()
  const ctx = contextNow(sheetId)
  if (!settings.snapping || !ctx || ctx.shapeOnly || !ctx.items.length) return p
  const r = snapPoint(p, prepareContext(ctx).lines, { radius: settings.snapRadiusPt })
  return r.kind === 'none' ? p : r.point
}

// ───────────── scale bar (V1-01) ─────────────

/** The sheet under the middle of the viewport, else the visible sheet nearest to it; only if its scale is known. */
function sheetForHud(vw: number, vh: number): { sheet: Sheet; scale: number } | null {
  const { placements, sheets } = getDocState()
  const cam = getCamera()
  const c = screenToBoard(cam, { x: vw / 2, y: vh / 2 })
  let pl = sheetAt(placements, c)
  if (!pl) {
    const vis = visibleBoardRect(cam, vw, vh)
    let best = Infinity
    for (const p of placements) {
      if (!rectsIntersect(vis, p)) continue
      const dx = Math.max(p.x - c.x, 0, c.x - (p.x + p.w))
      const dy = Math.max(p.y - c.y, 0, c.y - (p.y + p.h))
      const d = Math.hypot(dx, dy)
      if (d < best) [best, pl] = [d, p]
    }
  }
  const at = pl && sheets.find((s) => s.id === pl.sheetId)
  const scale = at ? sheetScale(at.id) : undefined
  return at && scale ? { sheet: at, scale } : null
}

/** A steady wobble: the same bar draws the same way on every render, so it does not shimmer while zooming. */
const wob = (i: number, amp: number) => Math.sin(i * 12.9898 + 4.1) * amp

/**
 * The scale bar drawn like a marker sketch: a wobbly outline that overshoots its corners a little, and the 1st and
 * 3rd quarters filled with a quick zigzag scribble. Exactly `px` wide between its end ticks (the overshoot spills
 * outside), so the bar still measures true.
 */
function SketchScaleBar({ px }: { px: number }) {
  const H = 10
  const q = px / 4
  const f = (n: number) => n.toFixed(1)
  const line = (x0: number, y0: number, x1: number, y1: number, k: number) => {
    const mx = (x0 + x1) / 2 + wob(k, 0.6)
    const my = (y0 + y1) / 2 + wob(k + 1, 1.3)
    return `M${f(x0)} ${f(y0)}Q${f(mx)} ${f(my)} ${f(x1)} ${f(y1)}`
  }
  let outline = line(-1.5, 1 + wob(1, 0.4), px + 1.2, 1.2 + wob(2, 0.4), 3) + line(-1, H - 0.8 + wob(4, 0.4), px + 1.6, H - 1 + wob(5, 0.4), 6)
  for (let i = 0; i <= 4; i++) outline += line(i * q + wob(i + 7, 0.5), -0.8, i * q + wob(i + 9, 0.6), H + 0.6, i + 11)
  let fill = ''
  for (const seg of [0, 2]) {
    const x0 = seg * q + 1.4
    const x1 = (seg + 1) * q - 1.4
    const step = 1.6
    let d = `M${f(x0)} ${f(H - 1.6)}`
    for (let x = x0, up = true; x < x1; x += step, up = !up) d += `L${f(Math.min(x + step, x1))} ${f(up ? 1.6 + wob(x, 0.5) : H - 1.6 + wob(x, 0.5))}`
    fill += d
  }
  return (
    <svg className="sketch-scale" width={px} height={H} viewBox={`0 0 ${f(px)} ${H}`} overflow="visible">
      <path d={fill} strokeWidth="2.3" />
      <path d={outline} strokeWidth="1.7" />
    </svg>
  )
}

export function ScaleBarHud({ viewport }: { viewport: () => { w: number; h: number } }) {
  const { scaleBar } = useView()
  useContexts() // re-render when a scale is found
  // re-render on every camera change (cheap: a few spans)
  const { z } = useSyncExternalStore(subscribeCamera, getCamera)
  if (!scaleBar) return null
  const vp = viewport()
  const target = sheetForHud(vp.w, vp.h)
  const bar = target ? scaleBarFor(z, target.scale) : null
  if (!target || !bar) return null
  return (
    <div className="scale-hud" data-testid="scale-bar" data-metres={bar.metres} data-scale={target.scale} aria-label={`Scale bar: ${bar.labels[2]}, sheet scale 1:${target.scale}`}>
      <div className="scale-title">
        {target.sheet.number ?? target.sheet.name} · 1:{target.scale}
      </div>
      <div className="scale-bar" style={{ width: bar.px }} aria-hidden="true">
        <SketchScaleBar px={bar.px} />
      </div>
      <div className="scale-labels" style={{ width: bar.px }} aria-hidden="true">
        {bar.labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </div>
  )
}
