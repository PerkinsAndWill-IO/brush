/**
 * Trace paper (P1-10): the layer laid over a sheet after a photo import, and the floating control for it.
 * State is in ./trace.ts. The look follows the "Trace paper" roll of docs/design (v2 Minimal board): a canary
 * roll glides across the sheet and the paper unrolls behind it; the strokes on it are revealed with the paper.
 */
import { useMemo, type CSSProperties } from 'react'
import { useDocState } from '../store'
import { useSession } from '../session'
import { photoGroups } from './groups'
import { ROLL_UP_MS, UNROLL_MS, tracePaper, useSheetTrace, useTraceStore } from './trace'

let grainUrl: string | null = null
/** A tile of paper grain and fibres, made once: cheaper than an SVG turbulence filter repainted on every zoom. */
function paperGrain(): string {
  if (grainUrl) return grainUrl
  const n = 192
  const c = document.createElement('canvas')
  c.width = c.height = n
  const g = c.getContext('2d')
  if (!g) return (grainUrl = '')
  const img = g.createImageData(n, n)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < n * n; i++) {
    const v = rnd()
    img.data[i * 4] = 92
    img.data[i * 4 + 1] = 80
    img.data[i * 4 + 2] = 52
    img.data[i * 4 + 3] = v > 0.5 ? Math.round((v - 0.5) * 34) : 0
  }
  g.putImageData(img, 0, 0)
  // a few long, faint fibres
  g.strokeStyle = 'rgba(120, 96, 40, 0.07)'
  g.lineWidth = 0.6
  for (let i = 0; i < 26; i++) {
    const x = rnd() * n
    const y = rnd() * n
    const a = rnd() * Math.PI
    const l = 10 + rnd() * 26
    g.beginPath()
    g.moveTo(x, y)
    g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + rnd() * 6, y + Math.sin(a) * l * 0.5 + rnd() * 6, x + Math.cos(a) * l, y + Math.sin(a) * l)
    g.stroke()
  }
  return (grainUrl = c.toDataURL('image/png'))
}

/** The trace on one sheet: rendered inside the sheet's paper, under the ink. Nothing when the sheet has none. */
export function TraceLayer({ sheetId }: { sheetId: string }) {
  const t = useSheetTrace(sheetId)
  const { opacity } = useTraceStore()
  const grain = useMemo(() => (t ? paperGrain() : ''), [t])
  if (!t) return null
  const style = {
    '--trace-alpha': String(opacity),
    '--trace-unroll': `${UNROLL_MS}ms`,
    '--trace-rollup': `${ROLL_UP_MS}ms`,
    '--trace-grain': grain ? `url(${grain})` : 'none',
  } as CSSProperties
  return (
    <div className="trace" data-layer="trace" data-phase={t.phase} data-testid="trace-paper" style={style} key={t.run} aria-hidden="true">
      <div className="trace-sheet" />
      {t.phase !== 'shown' && (
        <div className="trace-roll">
          <span className="trace-roll-body" />
          <span className="trace-roll-cap top" />
          <span className="trace-roll-cap bottom" />
        </div>
      )}
    </div>
  )
}

function RollIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3.5" width="5" height="17" rx="2.5" fill="#f3d27a" />
      <path d="M8 5.5h11.5a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8" fill="rgba(255,226,150,.55)" />
      <path d="M11 15c1.6-2.4 3.2-3.6 5-2.2" />
    </svg>
  )
}

/**
 * The trace control, top of the board: shown while the active sheet holds photo strokes. With the trace down it is
 * the opacity slider and Roll up; with it up, one button lays it again.
 */
export function TraceControl() {
  const doc = useDocState()
  const ses = useSession()
  const { sheets, opacity } = useTraceStore()
  const sheetId = ses.activeSheetId
  const hasInk = useMemo(() => !!sheetId && photoGroups(ses.strokes, ses.accepted).some((g) => g.sheetId === sheetId), [ses.strokes, ses.accepted, sheetId])
  if (doc.status !== 'ready' || !sheetId || !hasInk) return null
  const t = sheets.get(sheetId)
  const down = !!t && t.phase !== 'rolling'
  const pct = Math.round(opacity * 100)
  return (
    <div className={`trace-control${down ? ' down' : ''}`} role="group" aria-label="Trace paper" data-testid="trace-control" data-state={t?.phase ?? 'up'}>
      <RollIcon />
      {down ? (
        <>
          <label className="trace-slider">
            <span>Trace paper</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct}
              aria-valuetext={`${pct}% opaque`}
              data-testid="trace-opacity"
              style={{ '--pct': `${pct}%` } as CSSProperties}
              onChange={(e) => tracePaper.setOpacity(Number(e.target.value) / 100)}
            />
            <span className="mono-num">{pct}%</span>
          </label>
          <button type="button" className="trace-btn" data-testid="trace-roll-up" onClick={() => tracePaper.rollUp(sheetId)} title="Roll the trace paper up; the strokes stay">
            Roll up
          </button>
        </>
      ) : (
        <button type="button" className="trace-btn" data-testid="trace-unroll" onClick={() => tracePaper.unroll(sheetId)} title="Lay the trace paper over this sheet again">
          Lay trace paper
        </button>
      )}
    </div>
  )
}
