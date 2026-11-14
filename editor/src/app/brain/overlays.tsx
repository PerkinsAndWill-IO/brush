/**
 * Sheet overlays (rendered in each sheet's overlay <svg>, in sheet points):
 *  - ContextOverlay  (M2, dev/debug toggle): what was detected on the sheet
 *  - ElementsOverlay (M3): committed elements drawn over their faded ink
 *  - LiveOverlay     (M2/M3): ghost geometry and snap markers of the stroke in progress
 * plus LiveHud, the confidence chip(s) by the pen in screen space.
 * Sizes that must stay constant on screen divide by --z (camera zoom).
 */
import { useSyncExternalStore } from 'react'
import type { AcceptedDecision, ContextItem, ContextItemKind, DecisionKind, Hypothesis, Path, Point, Sheet } from '@core/types'
import type { SnapResult } from '@core/geometry'
import { getCamera, subscribeCamera } from '../camera'
import { sheetToScreen, type Placement } from '../board/layout'
import { useSession } from '../session'
import { getDocState } from '../store'
import { contextNow, useContexts } from './contextStore'
import { getLive, useLive } from './live'
import { acceptReading } from './predictEngine'

export const KIND_LABEL: Record<DecisionKind, string> = { wall: 'Wall', door: 'Door', furniture: 'Furniture', delete: 'Delete', markup: 'Markup' }
const ACCENT = 'var(--accent)'
const DELETE = 'var(--error)'
const px = (n: number) => `calc(${n}px / var(--z))`
const d = (pts: readonly Point[], closed = false) => (pts.length ? `M${pts.map((p) => `${p.x} ${p.y}`).join('L')}${closed ? 'Z' : ''}` : '')

// ───────────── element / ghost geometry ─────────────

function DoorSymbol({ path, dash, opacity }: { path: Path; dash?: string; opacity: number }) {
  const [a, b] = [path.points[0], path.points[path.points.length - 1]]
  const w = Math.hypot(b.x - a.x, b.y - a.y)
  if (w <= 0) return null
  // leaf: hinge at a, open 90° (to the left of a→b in y-down)
  const ux = (b.x - a.x) / w
  const uy = (b.y - a.y) / w
  const leaf = { x: a.x + uy * w, y: a.y - ux * w }
  return (
    <g opacity={opacity} strokeDasharray={dash}>
      <path d={d([a, b])} stroke="var(--paper)" strokeWidth={6} />
      <path d={d([a, leaf])} stroke={ACCENT} style={{ strokeWidth: px(2) }} />
      <path d={`M${leaf.x} ${leaf.y}A${w} ${w} 0 0 1 ${b.x} ${b.y}`} fill="none" stroke={ACCENT} style={{ strokeWidth: px(1.2) }} />
      <path d={d([a, b])} stroke={ACCENT} style={{ strokeWidth: px(1.2) }} />
    </g>
  )
}

function Strike({ items, opacity, dash }: { items: ContextItem[]; opacity: number; dash?: string }) {
  return (
    <g opacity={opacity} strokeDasharray={dash}>
      {items.map((it) => {
        const xs = it.geometry.points.map((p) => p.x)
        const ys = it.geometry.points.map((p) => p.y)
        const [x0, x1, y0, y1] = [Math.min(...xs) - 2, Math.max(...xs) + 2, Math.min(...ys) - 2, Math.max(...ys) + 2]
        return (
          <g key={it.id} data-delete-target={it.id}>
            <path d={d(it.geometry.points, it.geometry.closed)} fill="none" stroke={DELETE} style={{ strokeWidth: px(2) }} />
            <path d={`M${x0} ${y0}L${x1} ${y1}M${x0} ${y1}L${x1} ${y0}`} stroke={DELETE} style={{ strokeWidth: px(1.6) }} />
          </g>
        )
      })}
    </g>
  )
}

/** Geometry of a reading: committed (solid) or ghost (lighter; dashed while unstable). */
export function ReadingShape({ kind, geometry, type, targets, sheetId, ghost, stable }: { kind: DecisionKind; geometry: Path; type?: string; targets?: string[]; sheetId: string; ghost: boolean; stable: boolean }) {
  const dash = ghost && !stable ? '6 4' : undefined
  const op = ghost ? 0.85 : 1
  const pts = geometry.points
  switch (kind) {
    case 'wall':
      return (
        <g data-kind="wall" opacity={op}>
          <path d={d(pts, geometry.closed)} fill="none" stroke={ACCENT} strokeOpacity={0.38} strokeWidth={6} strokeLinejoin="miter" strokeDasharray={dash} />
          <path d={d(pts, geometry.closed)} fill="none" stroke={ACCENT} style={{ strokeWidth: px(1.2) }} strokeDasharray={dash} />
        </g>
      )
    case 'door':
      return pts.length >= 2 ? (
        <g data-kind="door">
          <DoorSymbol path={geometry} dash={dash} opacity={op} />
        </g>
      ) : null
    case 'furniture': {
      const sym = type !== undefined && pts.length === 4 ? getDocState().source?.furnitureSymbols?.().get(type) : undefined
      if (sym) {
        // the type's own plan symbol (as drawn on the sheet), fitted to the placed box: pts[0]->pts[1] is its width
        const [o, a, , b] = pts
        const c = { x: (pts[0].x + pts[2].x) / 2, y: (pts[0].y + pts[2].y) / 2 }
        const U = { x: a.x - o.x, y: a.y - o.y }
        const V = { x: b.x - o.x, y: b.y - o.y }
        const at = (q: Point): Point => ({ x: c.x + U.x * q.x + V.x * q.y, y: c.y + U.y * q.x + V.y * q.y })
        return (
          <g data-kind="furniture" data-symbol={type} opacity={op}>
            <path d={sym.lines.map((l) => d(l.pts.map(at), l.closed)).join('')} fill="none" stroke={ACCENT} style={{ strokeWidth: px(1.4) }} strokeDasharray={dash} />
          </g>
        )
      }
      return (
        <g data-kind="furniture" opacity={op}>
          <path d={d(pts, true)} fill={ACCENT} fillOpacity={0.16} stroke={ACCENT} style={{ strokeWidth: px(1.4) }} strokeDasharray={dash} />
        </g>
      )
    }
    case 'delete': {
      const ctx = contextNow(sheetId)
      const items = (targets ?? []).map((id) => ctx?.items.find((i) => i.id === id)).filter((x): x is ContextItem => !!x)
      return (
        <g data-kind="delete">
          <Strike items={items} opacity={op} dash={dash} />
        </g>
      )
    }
    default:
      return null
  }
}

// ───────────── overlays ─────────────

export function ElementsOverlay({ sheet }: { sheet: Sheet; placement: Placement }) {
  const { accepted, hidden } = useSession()
  useContexts() // delete targets resolve once the context is in
  // hidden: landed in the linked model (M6-04), the sheet draws the real element now
  const mine = accepted.filter((a) => a.sheetId === sheet.id && !hidden.has(a.strokeId))
  return (
    <g data-layer="elements">
      {mine.map((a: AcceptedDecision) => (
        <g key={a.strokeId} data-element={a.kind} data-stroke-id={a.strokeId}>
          <ReadingShape kind={a.kind} geometry={a.geometry} type={a.type} targets={a.targets} sheetId={sheet.id} ghost={false} stable />
        </g>
      ))}
    </g>
  )
}

function SnapMarker({ snap, which }: { snap: SnapResult; which: 'start' | 'end' }) {
  const { x, y } = snap.point
  return (
    <g data-snap={which} data-x={x.toFixed(2)} data-y={y.toFixed(2)} data-snap-kind={snap.kind}>
      <circle cx={x} cy={y} style={{ r: px(7), strokeWidth: px(1.6) }} fill="var(--paper)" stroke={ACCENT} />
      <circle cx={x} cy={y} style={{ r: px(2.2) }} fill={ACCENT} />
    </g>
  )
}

export function LiveOverlay({ sheet }: { sheet: Sheet; placement: Placement }) {
  const live = useLive()
  if (live.sheetId !== sheet.id || live.phase === 'idle' || live.phase === 'committed' || live.phase === 'markup') return null
  const h = live.hypothesis
  return (
    <g data-layer="live">
      <GestureBox ids={live.gesture} />
      {h && h.kind !== 'markup' && h.geometry.points.length > 0 && (
        <g data-ghost={h.kind} data-stable={h.stable}>
          <ReadingShape kind={h.kind} geometry={h.geometry} type={h.type} targets={h.targets} sheetId={sheet.id} ghost stable={h.stable} />
        </g>
      )}
      {live.snapStart && <SnapMarker snap={live.snapStart} which="start" />}
      {live.snapEnd && <SnapMarker snap={live.snapEnd} which="end" />}
    </g>
  )
}

/** M3-11: a dashed box around the strokes read together, once there are two or more. */
function GestureBox({ ids }: { ids?: readonly string[] }) {
  const { strokes } = useSession()
  if (!ids || ids.length < 2) return null
  const pts = strokes.filter((s) => ids.includes(s.id)).flatMap((s) => s.points)
  if (!pts.length) return null
  const pad = 6
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const [x0, y0, x1, y1] = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
  return (
    <rect
      data-gesture-box={ids.length}
      x={x0}
      y={y0}
      width={x1 - x0}
      height={y1 - y0}
      fill="none"
      stroke={ACCENT}
      opacity={0.6}
      style={{ strokeWidth: px(1), strokeDasharray: `${px(4)} ${px(3)}` }}
    />
  )
}

const KIND_COLOR: Record<ContextItemKind, string> = {
  wall: '#D9480F',
  grid: '#0B6E78',
  opening: '#6B4BD8',
  fixture: '#1F8A4C',
  label: '#B42318',
  unknown: '#5A606A',
}

export function ContextOverlay({ sheet }: { sheet: Sheet; placement: Placement }) {
  const { contextOverlay } = useSession()
  const { contexts } = useContexts()
  const ctx = contexts.get(sheet.id)
  if (!contextOverlay || !ctx) return null
  return (
    <g data-layer="context" data-items={ctx.items.length}>
      {ctx.items.map((it) => {
        const o = 0.25 + 0.75 * Math.max(0, Math.min(1, it.confidence))
        const c = KIND_COLOR[it.kind]
        const pts = it.geometry.points
        if (it.kind === 'label') {
          const xs = pts.map((p) => p.x)
          const ys = pts.map((p) => p.y)
          const [x0, y0, x1, y1] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
          return (
            <g key={it.id} opacity={o} data-kind="label">
              <rect x={x0} y={y0} width={Math.max(1, x1 - x0)} height={Math.max(1, y1 - y0)} fill={c} fillOpacity={0.12} stroke={c} strokeWidth={0.5} />
            </g>
          )
        }
        return (
          <g key={it.id} opacity={o} data-kind={it.kind}>
            <path
              d={d(pts, it.geometry.closed)}
              fill={it.kind === 'fixture' || it.kind === 'opening' ? c : 'none'}
              fillOpacity={0.15}
              stroke={c}
              strokeWidth={it.kind === 'wall' ? 3 : 1.2}
              strokeDasharray={it.kind === 'grid' ? '10 4 2 4' : undefined}
            />
            {it.kind === 'grid' && it.text && pts[0] && (
              <text x={pts[0].x} y={pts[0].y - 4} fill={c} fontSize={10} fontFamily="var(--mono)">
                {it.text}
              </text>
            )}
          </g>
        )
      })}
      <text x={8} y={sheet.sizePt.h - 8} fill="#1B1D21" fontSize={9} fontFamily="var(--mono)">
        context: {ctx.items.length} items{ctx.scale ? ` · 1:${ctx.scale}` : ''}
      </text>
    </g>
  )
}

// ───────────── chips by the pen (screen space) ─────────────

function Chip({ kind, confidence, type, primary, onPick, model, testId = 'pen-chip' }: { kind: DecisionKind; confidence: number; type?: string; primary: boolean; onPick?: () => void; model?: boolean; testId?: string }) {
  const Tag = onPick ? 'button' : 'div'
  return (
    <Tag
      type={onPick ? 'button' : undefined}
      className={`pen-chip${primary ? ' primary' : ''}${model ? ' model' : ''}`}
      data-testid={testId}
      data-kind={kind}
      data-origin={model ? 'model' : 'rules'}
      title={model ? 'From the second pass' : undefined}
      onClick={onPick}
    >
      <span className="dot" aria-hidden="true" />
      <span className="k">{KIND_LABEL[kind]}</span>
      {type && <span className="t">{type}</span>}
      <span className="mono-num">{Math.round(confidence * 100)}%</span>
    </Tag>
  )
}

const useCamera = () => useSyncExternalStore(subscribeCamera, getCamera)

/** Confidence chip near the pen; two tappable chips for 0.35–0.6 (rule 7). */
export function LiveHud() {
  const live = useLive()
  const cam = useCamera()
  const h: Hypothesis | undefined = live.hypothesis
  const pl = getDocState().placements.find((p) => p.sheetId === live.sheetId)
  if (pl && live.pen && live.suggestion && live.suggestion.strokeId === live.strokeId && live.phase === 'committed') {
    // rule 6: after commit a late second-pass answer is a suggestion chip only
    const at = sheetToScreen(cam, pl, live.pen)
    return (
      <div className="pen-chips" style={{ left: at.x + 18, top: at.y - 40 }}>
        <Chip kind={live.suggestion.kind} confidence={live.suggestion.confidence} primary={false} model testId="suggestion-chip" />
      </div>
    )
  }
  if (!h || !pl || !live.pen || !['drawing', 'pending', 'offer'].includes(live.phase)) return null
  const at = sheetToScreen(cam, pl, live.pen)
  const model = live.origin === 'model'
  const two = live.chips.length === 2
  if (h.kind === 'markup' && !two) return null
  const conf = (k: DecisionKind) => (k === h.kind ? h.confidence : (h.alternatives.find((a) => a.kind === k)?.confidence ?? 0))
  const canPick = live.phase !== 'drawing'
  return (
    <div className="pen-chips" style={{ left: at.x + 18, top: at.y - 40 }} data-testid="pen-chips" data-count={two ? 2 : 1}>
      {two ? (
        live.chips.map((k, i) => <Chip key={k} kind={k} confidence={conf(k)} type={k === h.kind ? h.type : undefined} primary={i === 0} onPick={canPick ? () => acceptReading(k) : undefined} model={model} />)
      ) : (
        <Chip kind={h.kind} confidence={h.confidence} type={h.type} primary model={model} />
      )}
    </div>
  )
}

/** Small note for sheets without usable context (scanned): the brush reads shape only (spec risk table). */
export function ContextBadge({ sheetId }: { sheetId: string }) {
  const { contexts, status } = useContexts()
  const ctx = contexts.get(sheetId)
  if (status.get(sheetId) === 'error') return <span className="ctx-note">no context</span>
  if (ctx && (ctx.shapeOnly || ctx.items.length === 0))
    return (
      <span className="ctx-note" data-testid="shape-only">
        shape only — no context
      </span>
    )
  return null
}

export const liveSnapshot = () => getLive()
