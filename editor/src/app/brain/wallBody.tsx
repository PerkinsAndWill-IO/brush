/**
 * A sketched wall drawn the way its type is drawn on the sheet (M3-03): at the type's thickness, with its faces,
 * layer lines and fills (WallStyle, taken from a placed instance of the type), mitred at corners, and ending at the
 * face of the wall it joins with that wall's face line broken. Display only: the element's geometry (centreline to
 * centreline, what `create_wall` takes) is unchanged.
 */
import type { ContextItem, Point } from '@core/types'
import { ptPerMetre, type WallStyle } from '@core/context'
import { getDocState } from '../store'
import { contextNow } from './contextStore'

const ACCENT = 'var(--accent)'
const d = (pts: readonly Point[], closed = false) => (pts.length ? `M${pts.map((p) => `${p.x} ${p.y}`).join('L')}${closed ? 'Z' : ''}` : '')
/** A sheet weight, but never thinner than half a screen pixel. */
const weight = (pt: number) => `max(${pt}px, calc(0.5px / var(--z)))`

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const len = (a: Point) => Math.hypot(a.x, a.y)
const unit = (a: Point): Point => {
  const l = len(a) || 1
  return { x: a.x / l, y: a.y / l }
}
const along = (p: Point, u: Point, t: number): Point => ({ x: p.x + u.x * t, y: p.y + u.y * t })
/** Left normal of a segment direction (the same side `wallStylesFromDrawing` measures offsets on). */
const normal = (u: Point): Point => ({ x: -u.y, y: u.x })

/** The polyline offset by `off` (sheet points) to its left, mitred at inner vertices (closed: at every vertex). */
export function offsetPolyline(pts: readonly Point[], off: number, closed: boolean): Point[] {
  const n = pts.length
  const dir = (i: number) => unit(sub(pts[(i + 1) % n], pts[i]))
  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0
    const hasNext = closed || i < n - 1
    const nIn = hasPrev ? normal(dir((i - 1 + n) % n)) : undefined
    const nOut = hasNext ? normal(dir(i)) : undefined
    if (nIn && nOut) {
      const m = unit({ x: nIn.x + nOut.x, y: nIn.y + nOut.y })
      const k = off / Math.max(0.25, dot(m, nOut)) // limit the mitre on hairpin turns
      out.push(along(pts[i], m, k))
    } else out.push(along(pts[i], (nIn ?? nOut)!, off))
  }
  return out
}

interface Join {
  /** Distance to move the end back along the wall to the host's face (negative: on past the centreline). */
  trim: number
  hostId: string
}

/** Where an end of the wall meets a placed wall: the trim that puts the end on that wall's face. */
function joinAt(end: Point, prev: Point, walls: readonly ContextItem[], halfOf: (w: ContextItem) => number): Join | undefined {
  const out = unit(sub(end, prev)) // pointing out of the new wall at this end
  const segLen = len(sub(end, prev))
  let best: (Join & { dist: number }) | undefined
  for (const w of walls) {
    const g = w.geometry.points
    const half = halfOf(w)
    if (!(half > 0)) continue
    for (let i = 0; i + 1 < g.length; i++) {
      const hl = len(sub(g[i + 1], g[i]))
      if (hl < 1e-6) continue
      const hu = unit(sub(g[i + 1], g[i]))
      const hn = normal(hu)
      const cos = dot(out, hn)
      if (Math.abs(cos) < Math.sin((25 * Math.PI) / 180)) continue // (nearly) parallel: not a join
      const s = dot(sub(end, g[i]), hn) // signed distance of the end from the host's centreline
      if (Math.abs(s) > half + 1.5) continue
      const a = dot(sub(end, g[i]), hu) // position along the host
      if (a < -half - 1.5 || a > hl + half + 1.5) continue
      // T-junction: stop at the near face. At the host's end (a corner): run on to the far face, covering the corner.
      const side = Math.sign(dot(sub(prev, g[i]), hn)) || 1
      const corner = a < half * 1.5 || a > hl - half * 1.5
      const target = (corner ? -side : side) * half
      const trim = (s - target) / cos
      if (trim >= segLen * 0.9 || trim < -3 * half) continue
      const dist = Math.abs(s)
      if (!best || dist < best.dist) best = { trim, hostId: w.id, dist }
    }
  }
  return best && { trim: best.trim, hostId: best.hostId }
}

export function WallBody({ pts, closed, type, sheetId, opacity, dash }: { pts: readonly Point[]; closed: boolean; type?: string; sheetId: string; opacity: number; dash?: string }) {
  const source = getDocState().source
  const ctx = contextNow(sheetId)
  const ptPerM = ctx?.scale ? ptPerMetre(ctx.scale) : undefined
  const styles = source?.wallStyles?.()
  const style: WallStyle | undefined = type !== undefined ? styles?.get(type) : undefined
  const thicknessOf = (s: WallStyle | undefined, name: string | undefined): number | undefined => {
    if (s) return s.thicknessMm && ptPerM ? (s.thicknessMm / 1000) * ptPerM : s.thicknessPt
    const def = name !== undefined ? source?.palette.walls.find((w) => w.name === name) : undefined
    return def && ptPerM ? (def.thicknessMm / 1000) * ptPerM : undefined
  }
  const T = thicknessOf(style, type)
  if (pts.length < 2 || !style || !(T && T > 0)) {
    // no linework for this type (a PDF, an unknown type): a band, at the type's thickness when the scale is known
    return (
      <g data-wall-style="" data-thickness-pt={T ? T.toFixed(2) : ''} opacity={opacity}>
        <path d={d(pts, closed)} fill="none" stroke={ACCENT} strokeOpacity={0.38} strokeWidth={T ?? 6} strokeLinejoin="miter" strokeDasharray={dash} />
        <path d={d(pts, closed)} fill="none" stroke={ACCENT} style={{ strokeWidth: 'calc(1.2px / var(--z))' }} strokeDasharray={dash} />
      </g>
    )
  }

  // ends that join a placed wall stop at its face; free ends get a cap
  const walls = (ctx?.items ?? []).filter((i) => i.kind === 'wall' && i.geometry.points.length >= 2)
  const halfOf = (w: ContextItem) => {
    const t = thicknessOf(w.props?.typeName ? styles?.get(w.props.typeName) : undefined, undefined) ?? Number(w.props?.thicknessPt ?? 0)
    return t / 2
  }
  const n = pts.length
  const start = closed ? undefined : joinAt(pts[0], pts[1], walls, halfOf)
  const end = closed ? undefined : joinAt(pts[n - 1], pts[n - 2], walls, halfOf)
  const heavy = Math.max(...style.lines.map((l) => l.weightPt))
  const ends = (extra: number): Point[] => {
    const p = pts.slice()
    if (start) p[0] = along(pts[0], unit(sub(pts[1], pts[0])), start.trim - extra)
    if (end) p[n - 1] = along(pts[n - 1], unit(sub(pts[n - 2], pts[n - 1])), end.trim - extra)
    return p
  }
  const body = ends(0)
  // the paper runs on past the host's face just far enough to break its face line between this wall's faces
  const cover = ends(heavy / 2 + 0.15)
  const band = (from: number, to: number, path: Point[]) => {
    const a = offsetPolyline(path, from * T, closed)
    const b = offsetPolyline(path, to * T, closed).reverse()
    return closed ? `${d(a, true)}${d(b, true)}` : d([...a, ...b], true)
  }
  const fillColor = (c: readonly number[]) => (c[0] > 245 && c[1] > 245 && c[2] > 245 ? 'var(--paper)' : `rgb(${c[0]} ${c[1]} ${c[2]})`)
  const caps: Point[][] = []
  if (!closed && !start) caps.push(offsetPolyline(body.slice(0, 2), -T / 2, false).slice(0, 1).concat(offsetPolyline(body.slice(0, 2), T / 2, false).slice(0, 1)))
  if (!closed && !end) caps.push(offsetPolyline(body.slice(n - 2), -T / 2, false).slice(1).concat(offsetPolyline(body.slice(n - 2), T / 2, false).slice(1)))
  const joined = [start?.hostId, end?.hostId].filter((x): x is string => !!x)
  return (
    <g data-wall-style={type} data-thickness-pt={T.toFixed(2)} data-lines={style.lines.length} data-joined={joined.join(' ')} opacity={opacity}>
      <path data-part="paper" d={band(-0.5, 0.5, cover)} fill="var(--paper)" fillRule="evenodd" stroke="none" />
      {style.fills
        .filter((f) => fillColor(f.color) !== 'var(--paper)')
        .map((f, i) => (
          <path key={`f${i}`} d={band(f.from, f.to, body)} fill={fillColor(f.color)} fillRule="evenodd" stroke="none" />
        ))}
      {style.lines.map((l, i) => {
        const face = Math.abs(l.offset) >= 0.499
        return (
          <path
            key={`l${i}`}
            data-part={face ? 'face' : 'layer'}
            d={d(offsetPolyline(body, l.offset * T, closed), closed)}
            fill="none"
            stroke={ACCENT}
            strokeLinejoin="miter"
            strokeLinecap={face ? 'square' : 'butt'} // faces close the corner where they meet the host's face line
            style={{ strokeWidth: weight(l.weightPt) }}
            strokeDasharray={face ? dash : undefined}
          />
        )
      })}
      {caps.map((c, i) => (
        <path key={`c${i}`} data-part="cap" d={d(c)} stroke={ACCENT} style={{ strokeWidth: weight(heavy) }} strokeDasharray={dash} />
      ))}
    </g>
  )
}
