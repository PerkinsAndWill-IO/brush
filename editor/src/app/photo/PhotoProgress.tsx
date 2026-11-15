/**
 * The import dialog while a photo is read (P1-13): the photo on a little light table, acted out per stage
 * (it develops, a loupe looks for the sheet, pins hold it flat, a pencil traces it), four steps, a bar that
 * never stalls, a rotating line of patter and, when asked for, the model's first glance at the sketch.
 * The import's own progress lines stay one click away under Details.
 */
import { useEffect, useMemo, useState } from 'react'
import { STAGES, STAGE_TITLE, clock, patter, progressFraction, type ImportStage } from './progress'

export interface ProgressView {
  stage: ImportStage
  /** performance.now() when the import started / the stage began. */
  startedAt: number
  stageAt: number
  /** The sheet being compared, while finding it. */
  sheet?: string
  /** The model's first glance: undefined = not asked, null = asked and waiting (or nothing came back). */
  glance?: string | null
  lines: readonly string[]
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

/** Types a line out, a few characters at a time. */
function useTyped(text: string | null | undefined): string {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    if (!text) return
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (still) return setN(text.length)
    const id = setInterval(() => setN((k) => (k >= text.length ? (clearInterval(id), k) : k + 2)), 28)
    return () => clearInterval(id)
  }, [text])
  return text ? text.slice(0, n) : ''
}

/** Hand-drawn squiggles the pencil follows while tracing, in the photo box's own 0..300 x 0..200 units. */
const SQUIGGLES = [
  'M62 74 C80 70 104 72 118 76 C120 96 118 116 116 132 C98 134 80 132 64 130 Z',
  'M136 78 C152 74 170 76 184 80 M160 78 C162 98 160 118 158 136',
  'M196 120 C214 112 236 118 252 112 C258 128 252 140 246 150',
]

export function PhotoProgress({ photoUrl, fileName, view }: { photoUrl: string | null; fileName?: string; view: ProgressView }) {
  const now = useNow(250)
  const inStage = (now - view.stageAt) / 1000
  const frac = progressFraction(view.stage, inStage)
  const stageIndex = STAGES.indexOf(view.stage)
  const line = patter(view.stage, inStage, view.sheet)
  const typed = useTyped(view.glance)
  const pins = useMemo(() => ['tl', 'tr', 'bl', 'br'], [])

  return (
    <div className="photo-progress-view" data-stage={view.stage}>
      <div className="lightbox" aria-hidden="true">
        <div className="lightbox-print" data-stage={view.stage}>
          {photoUrl ? <img src={photoUrl} alt="" draggable={false} /> : <div className="lightbox-blank" />}
          <div className="lightbox-scan" />
          <div className="lightbox-loupe">{photoUrl && <img src={photoUrl} alt="" draggable={false} />}</div>
          {pins.map((p) => (
            <span key={p} className={`lightbox-pin ${p}`} />
          ))}
          <svg className="lightbox-trace" viewBox="0 0 300 200" preserveAspectRatio="none">
            {SQUIGGLES.map((d, i) => (
              <path key={i} d={d} pathLength={1} style={{ animationDelay: `${i * 1.1}s` }} />
            ))}
          </svg>
          <svg className="lightbox-pencil" width="34" height="34" viewBox="0 0 34 34" style={{ offsetPath: `path('${SQUIGGLES.join(' ')}')` }}>
            <g transform="rotate(45 17 17)">
              <rect x="13" y="3" width="8" height="20" rx="1.5" fill="#f3c44e" stroke="#3e2e28" strokeWidth="1.3" />
              <path d="M13 23 L17 31 L21 23 Z" fill="#f6dfc4" stroke="#3e2e28" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M16 28.6 L17 31 L18 28.6 Z" fill="#3e2e28" />
              <rect x="13" y="1" width="8" height="4" rx="1.2" fill="#d9583f" stroke="#3e2e28" strokeWidth="1.3" />
            </g>
          </svg>
        </div>
      </div>

      <ol className="import-steps" aria-label="Steps">
        {STAGES.map((s, i) => (
          <li key={s} data-state={i < stageIndex ? 'done' : i === stageIndex ? 'now' : 'next'} aria-current={i === stageIndex ? 'step' : undefined}>
            <span className="step-dot" aria-hidden="true">
              {i < stageIndex ? (
                <svg width="10" height="10" viewBox="0 0 10 10">
                  <path d="M2 5.2 L4.2 7.4 L8 2.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            {STAGE_TITLE[s]}
          </li>
        ))}
      </ol>

      <div className="import-bar" role="progressbar" aria-label="Reading the photo" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}>
        <span style={{ width: `${frac * 100}%` }} />
      </div>

      <div className="import-patter">
        <p data-testid="photo-progress" aria-live="polite" key={line}>
          {line}
        </p>
        <span className="mono-num" title="Time so far">
          {clock((now - view.startedAt) / 1000)}
        </span>
      </div>

      {view.glance !== undefined && (
        <div className="first-glance" data-testid="photo-glance" data-state={view.glance ? 'ready' : 'waiting'}>
          <span className="first-glance-label">First glance</span>
          <p>
            {view.glance ? (
              <>
                {typed}
                {typed.length < view.glance.length && <span className="caret" aria-hidden="true" />}
              </>
            ) : (
              <span className="first-glance-wait">Taking a look at {fileName ?? 'the photo'}…</span>
            )}
          </p>
        </div>
      )}

      <details className="import-details">
        <summary>Details</summary>
        <ol className="progress">
          {view.lines.slice(-8).map((l, i) => (
            <li key={`${view.lines.length}-${i}`}>{l}</li>
          ))}
        </ol>
      </details>
    </div>
  )
}
