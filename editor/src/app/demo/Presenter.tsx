/**
 * The presenter's "Show more" button (DEMO.md): each click plays the next step of the demo in the real app, so the
 * person on stage sets the pace while they talk, and can stop wherever the clock says. On with `?demo` in the URL.
 *
 * PageDown, → and N also advance (what presentation clickers send); H hides the button for a clean screen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { endPresenting, presenterSteps, resetRehearsal } from './rehearse'

type Phase = { t: 'ready' } | { t: 'running' } | { t: 'failed'; message: string }

export default function Presenter() {
  const steps = useMemo(() => presenterSteps(), [])
  const [next, setNext] = useState(0)
  const [phase, setPhase] = useState<Phase>({ t: 'ready' })
  const [hidden, setHidden] = useState(false)
  const busy = useRef(false)
  const done = next >= steps.length

  useEffect(() => endPresenting, [])

  const advance = useCallback(async () => {
    if (busy.current || next >= steps.length) return
    busy.current = true
    setPhase({ t: 'running' })
    try {
      await steps[next].run()
      setNext(next + 1)
      setPhase({ t: 'ready' })
    } catch (e) {
      // stays on this step: the next click tries it again
      setPhase({ t: 'failed', message: (e as Error).message.replace(/^demo: /, '') })
    } finally {
      busy.current = false
    }
  }, [next, steps])

  const startOver = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setPhase({ t: 'running' })
    try {
      await resetRehearsal()
      setNext(0)
      setPhase({ t: 'ready' })
    } catch (e) {
      setPhase({ t: 'failed', message: (e as Error).message })
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el?.closest?.('input, textarea, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        void advance()
      } else if (e.key === 'h' || e.key === 'H') {
        setHidden((h) => !h)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance])

  if (hidden) return null
  const running = phase.t === 'running'
  const step = steps[Math.min(next, steps.length - 1)]

  return (
    <div className={`presenter${running ? ' running' : ''}${done ? ' done' : ''}`} data-testid="presenter" data-step={done ? 'done' : step.id}>
      <ol className="presenter-dots" aria-label={`Step ${Math.min(next + 1, steps.length)} of ${steps.length}`}>
        {steps.map((s, i) => (
          <li key={s.id} data-state={i < next ? 'done' : i === next && !done ? 'next' : 'todo'} title={s.label} />
        ))}
      </ol>
      {done ? (
        <div className="presenter-end">
          <span className="presenter-fin">That's the demo ✦</span>
          <button type="button" className="presenter-again" onClick={() => void startOver()} disabled={running} data-testid="presenter-start-over">
            {running ? 'Cleaning up…' : 'Start over'}
          </button>
        </div>
      ) : (
        <button type="button" className="presenter-btn" onClick={() => void advance()} disabled={running} data-testid="presenter-next">
          <span className="presenter-main">
            {running ? `${step.label}…` : phase.t === 'failed' ? 'Try again' : 'Show more'}
            {!running && (
              <svg className="presenter-arrow" viewBox="0 0 28 16" aria-hidden="true">
                <path d="M2 8.5c6-.8 13-1 22-.3M18 2.5c2.4 2 4.3 3.6 6.3 5.6-2.2 1.8-4 3.5-6 5.6" />
              </svg>
            )}
          </span>
          {!running && <span className="presenter-sub">{phase.t === 'failed' ? phase.message : `Next: ${step.label}`}</span>}
        </button>
      )}
      <button type="button" className="presenter-hide" onClick={() => setHidden(true)} aria-label="Hide (H)" title="Hide (H)">
        ×
      </button>
    </div>
  )
}
