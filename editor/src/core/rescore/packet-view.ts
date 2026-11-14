import type { ContextItem, ContextPacket, Point } from '../types'

/**
 * A compact, deterministic view of a ContextPacket (M4-02): every adapter
 * serialises the SAME view, so prompts differ only in framing. Numbers are
 * rounded (so tiny float noise does not change the request hash), keys are in
 * a fixed order and ids are left out (they carry no meaning for a model).
 */
export interface PacketView {
  /** Stroke features. */
  f: {
    fit: string
    fits: [string, number][] // top 3 primitive fits [kind, score]
    lenPt: number
    lenM?: number
    sizePt: [number, number]
    sizeM?: [number, number]
    closed: boolean
    closure: number
    corners: number
    selfX: number
    durMs: number
    speed: number
    reversals: number
  }
  /** Nearest context items, closest first: kind, distance from the stroke centre (pt), text. */
  near: { k: string; d: number; t?: string }[]
  room?: string
  scale?: number
  /** Last accepted decisions, oldest first (kinds only). */
  hist: string[]
  /** First-pass candidates [kind, confidence], best first. */
  cand: [string, number][]
}

const r = (x: number, dp: number): number => {
  const m = 10 ** dp
  const v = Math.round(x * m) / m
  return Object.is(v, -0) ? 0 : v
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Distance from p to an item's geometry (polyline / polygon), in sheet points. */
export function itemDistance(p: Point, item: ContextItem): number {
  const pts = item.geometry.points
  if (!pts.length) return Infinity
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y)
  let d = Infinity
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1], pts[i]))
  if (item.geometry.closed) d = Math.min(d, segDist(p, pts[pts.length - 1], pts[0]))
  return d
}

export function packetView(packet: ContextPacket): PacketView {
  const f = packet.features
  const c = { x: f.bbox.x + f.bbox.w / 2, y: f.bbox.y + f.bbox.h / 2 }
  const view: PacketView = {
    f: {
      fit: f.fits[0]?.kind ?? 'unknown',
      fits: f.fits.slice(0, 3).map((x) => [x.kind, r(x.score, 2)]),
      lenPt: r(f.lengthPt, 0),
      sizePt: [r(f.bbox.w, 0), r(f.bbox.h, 0)],
      closed: f.closed,
      closure: r(f.closureRatio, 2),
      corners: f.cornerCount,
      selfX: f.selfIntersections,
      durMs: Math.round(f.durationMs / 10) * 10, // tens of ms
      speed: r(f.meanSpeed, 2),
      reversals: r(f.reversalDensity, 3),
    },
    near: packet.nearest
      .map((it) => {
        const n: { k: string; d: number; t?: string } = { k: it.kind, d: r(itemDistance(c, it), 0) }
        if (it.text) n.t = it.text.slice(0, 40)
        return n
      })
      .sort((a, b) => a.d - b.d || a.k.localeCompare(b.k) || (a.t ?? '').localeCompare(b.t ?? '')),
    hist: packet.history.map((h) => h.kind),
    cand: packet.candidates.map((a) => [a.kind, r(a.confidence, 2)]),
  }
  if (f.lengthM !== undefined) view.f.lenM = r(f.lengthM, 2)
  if (f.bboxM) view.f.sizeM = [r(f.bboxM.w, 2), r(f.bboxM.h, 2)]
  if (packet.roomLabel !== undefined) view.room = packet.roomLabel
  if (packet.scale !== undefined) view.scale = packet.scale
  return view
}

/** One-line-per-field text form of the view, for chat prompts. Deterministic. */
export function packetText(view: PacketView): string {
  const f = view.f
  const lines = [
    `stroke: best fit ${f.fit}; fits ${f.fits.map(([k, s]) => `${k}=${s}`).join(', ')}`,
    `size: length ${f.lenPt} pt${f.lenM !== undefined ? ` (${f.lenM} m)` : ''}, bbox ${f.sizePt[0]}x${f.sizePt[1]} pt${f.sizeM ? ` (${f.sizeM[0]}x${f.sizeM[1]} m)` : ''}`,
    `shape: closed=${f.closed} closure=${f.closure} corners=${f.corners} self-intersections=${f.selfX} reversal-density=${f.reversals}`,
    `motion: ${f.durMs} ms, mean speed ${f.speed} pt/ms`,
    `nearby: ${view.near.length ? view.near.map((n) => `${n.k}${n.t ? ` "${n.t}"` : ''} @${n.d}pt`).join('; ') : 'nothing (shape-only sheet)'}`,
    `room: ${view.room ?? 'unknown'}; scale: ${view.scale !== undefined ? `1:${view.scale}` : 'unknown'}`,
    `recent decisions: ${view.hist.length ? view.hist.join(', ') : 'none'}`,
    `first-pass guess: ${view.cand.map(([k, p]) => `${k} ${p}`).join(', ')}`,
  ]
  return lines.join('\n')
}
