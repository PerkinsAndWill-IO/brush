/**
 * Revit link UI (M6): the top-bar button and its panel (connect, pick sheets, status), the first-connect
 * explainer for a deployed page (M6-08), and the per-command results pinned on the ink (M6-05).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getCamera, subscribeCamera } from '../camera'
import { sheetToScreen } from '../board/layout'
import { useSession } from '../session'
import { useDocState } from '../store'
import { anchorOf, entryFor, revit, useRevit } from './controller'
import { ackExplainer, needsExplainer } from './lna'
import { sheetLabel } from './protocol'


const STATE_LABEL = { off: 'Revit', connecting: 'Connecting…', on: 'Revit', refused: 'Revit refused' } as const

/** M6-08: what the user is about to see the first time a deployed editor connects. */
function Explainer({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="revit-explainer" data-testid="revit-lna-explainer">
      <p className="revit-h">Before you connect</p>
      <ol>
        <li>
          <b>Chrome asks</b> whether <span className="mono">{location.host}</span> may access devices on your local network. Choose <b>Allow</b>: the
          editor talks to Revit on this computer only (<span className="mono">127.0.0.1</span>), never over the network.
        </li>
        <li>
          <b>Revit asks</b> once whether to allow this page in the Brush Link dialog. Choose <b>Allow always</b> to skip it next time.
        </li>
      </ol>
      <p className="secondary">Revit must be running with a model open and the Brush Link add-in on (Add-Ins → Brush → Brush Link).</p>
      <button
        type="button"
        className="btn accent"
        data-testid="revit-connect"
        onClick={() => {
          ackExplainer()
          onConnect()
        }}
      >
        Connect to Revit
      </button>
    </div>
  )
}

function PanelBody({ close }: { close: () => void }) {
  const rv = useRevit()
  const { state, detail, document, sheets, welcome } = rv.link
  const [explain, setExplain] = useState(needsExplainer)
  // M6-10: sheets ticked to open together
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set())

  if (state === 'off') {
    if (explain) return <Explainer onConnect={() => (setExplain(false), revit.connect())} />
    return (
      <div className="revit-body">
        <p className="revit-h">Live link to Revit</p>
        <p className="secondary">Sketch on a Revit sheet: walls, doors and furniture you draw go into the model, and the sheet comes back updated.</p>
        <button type="button" className="btn accent" data-testid="revit-connect" onClick={() => revit.connect()}>
          Connect to Revit
        </button>
      </div>
    )
  }
  if (state === 'connecting' || state === 'refused') {
    return (
      <div className="revit-body">
        <p className="revit-h">{state === 'refused' ? 'Revit did not let this page in' : 'Connecting to Revit…'}</p>
        <p className="secondary" data-testid="revit-detail">
          {detail ?? 'Looking for the Brush Link add-in on this computer.'}
        </p>
        <div className="revit-row">
          <button type="button" className="btn soft" data-testid="revit-retry" onClick={() => revit.retry()}>
            Try again
          </button>
          <button type="button" className="btn soft" onClick={() => revit.disconnect()}>
            {state === 'refused' ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    )
  }
  const open = new Map(rv.open.map((o) => [o.id, o.version]))
  const closed = sheets.filter((s) => !open.has(s.id) && !rv.opening.includes(s.id))
  // in list order, and only sheets still waiting to be opened
  const chosen = closed.filter((s) => picked.has(s.id)).map((s) => s.id)
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (!n.delete(id)) n.add(id)
      return n
    })
  const openChosen = () => {
    const first = rv.open.length === 0
    revit.openSheets(chosen)
    setPicked(new Set())
    if (first) close()
  }
  return (
    <div className="revit-body">
      <p className="revit-h">
        {document?.title ?? 'Revit'} <span className="secondary">{welcome?.server.host}</span>
      </p>
      {rv.autoNote && (
        <p className="revit-auto" data-testid="revit-auto-note">
          {rv.autoNote}
        </p>
      )}
      {rv.stale && (
        <p className="revit-warn" data-testid="revit-stale">
          The model changed in Revit while you drew. Your edits went in; check the sheet.
        </p>
      )}
      {rv.error && (
        <p className="error" role="alert" data-testid="revit-error">
          {rv.error}{' '}
          <button type="button" className="link-btn" onClick={() => revit.clearError()}>
            Dismiss
          </button>
        </p>
      )}
      {sheets.length === 0 ? (
        <p className="secondary">This model has no sheets.</p>
      ) : (
        <>
          {closed.length > 1 && (
            <div className="revit-row revit-pick-bar">
              <span className="secondary">{chosen.length ? `${chosen.length} selected` : 'Tick sheets to open several at once.'}</span>
              <button
                type="button"
                className="link-btn"
                data-testid="revit-select-all"
                onClick={() => setPicked(chosen.length === closed.length ? new Set() : new Set(closed.map((s) => s.id)))}
              >
                {chosen.length === closed.length ? 'Select none' : 'Select all'}
              </button>
            </div>
          )}
          <ul className="revit-sheets" data-testid="revit-sheets">
            {sheets.map((s) => {
              const v = open.get(s.id)
              const opening = rv.opening.includes(s.id)
              return (
                <li key={s.id} data-sheet-id={s.id} data-open={v !== undefined}>
                  {v !== undefined ? (
                    <button
                      type="button"
                      className="revit-sheet-name"
                      title="Show this sheet in Revit"
                      data-testid="revit-show-sheet"
                      onClick={() => revit.showSheet(s.id)}
                    >
                      {sheetLabel(s)}
                    </button>
                  ) : (
                    <label className="revit-sheet-name revit-pick">
                      <input
                        type="checkbox"
                        data-testid="revit-pick-sheet"
                        disabled={opening}
                        checked={!opening && picked.has(s.id)}
                        onChange={() => toggle(s.id)}
                      />
                      <span>{sheetLabel(s)}</span>
                    </label>
                  )}
                  {v !== undefined ? (
                    <>
                      <span className="mono-num secondary" data-testid="revit-version">
                        v{v}
                      </span>
                      {rv.open.length > 1 && (
                        <button type="button" className="chip-btn" onClick={() => void revit.closeSheet(s.id)}>
                          Close
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      className="chip-btn"
                      data-testid="revit-open-sheet"
                      disabled={opening}
                      onClick={() => {
                        revit.openSheet(s.id)
                        if (rv.open.length === 0) close()
                      }}
                    >
                      {opening ? 'Opening…' : rv.open.length ? 'Add' : 'Open'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          {chosen.length > 0 && (
            <button type="button" className="btn accent revit-open-chosen" data-testid="revit-open-selected" onClick={openChosen}>
              {`${rv.open.length ? 'Add' : 'Open'} ${chosen.length} ${chosen.length === 1 ? 'sheet' : 'sheets'}`}
            </button>
          )}
        </>
      )}
      <button
        type="button"
        className="toggle-row revit-stream"
        aria-pressed={rv.streaming}
        data-testid="revit-stream-toggle"
        onClick={() => revit.setStreaming(!rv.streaming)}
      >
        <span>
          Stream edits to Revit
          <span className="secondary revit-stream-sub">{rv.streaming ? 'Walls, doors and furniture go in as you draw.' : 'Paused: edits wait here until you send them.'}</span>
        </span>
        <span className={`switch${rv.streaming ? ' on' : ''}`} aria-hidden="true">
          <span />
        </span>
      </button>
      {!rv.streaming && rv.queued > 0 && (
        <div className="revit-row revit-queued">
          <span data-testid="revit-queued">{`${rv.queued} ${rv.queued === 1 ? 'edit' : 'edits'} waiting`}</span>
          <button type="button" className="btn accent" data-testid="revit-send-now" disabled={state !== 'on'} onClick={() => revit.flush()}>
            Send now
          </button>
        </div>
      )}
      <div className="revit-row">
        <span className="secondary" data-testid="revit-inflight">
          {rv.inFlight
            ? `Sending ${rv.inFlight} to Revit…`
            : !rv.open.length
              ? 'Pick sheets to sketch on.'
              : rv.streaming
                ? 'Edits go to Revit as you draw.'
                : 'Streaming paused.'}
        </span>
        <button type="button" className="btn soft" data-testid="revit-disconnect" onClick={() => revit.disconnect()}>
          Disconnect
        </button>
      </div>
    </div>
  )
}

/** Top-bar entry: status dot, and the panel. */
export function RevitButton() {
  const rv = useRevit()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  const st = rv.link.state
  const busy = rv.inFlight > 0 || rv.opening.length > 0
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className={`btn soft revit-btn state-${st}${busy ? ' busy' : ''}${rv.streaming ? '' : ' paused'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="revit-button"
        data-state={st}
        data-streaming={rv.streaming}
        title={rv.link.detail ?? (rv.streaming ? 'Live link to Revit' : `Live link to Revit: streaming paused${rv.queued ? `, ${rv.queued} waiting` : ''}`)}
        onClick={() => setOpen(!open)}
      >
        <span className="revit-dot" aria-hidden="true" />
        {st === 'on' && rv.open.length ? `Revit · ${rv.open.length === 1 ? (rv.link.sheets.find((s) => s.id === rv.open[0].id)?.number ?? '1 sheet') : `${rv.open.length} sheets`}` : STATE_LABEL[st]}
        {st === 'on' && !rv.streaming && <span className="revit-paused-tag">{rv.queued ? `paused · ${rv.queued}` : 'paused'}</span>}
      </button>
      {open && (
        <div className="menu revit-panel" role="dialog" aria-label="Revit link" data-testid="revit-panel">
          <PanelBody close={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

/** Start-page entry: the same panel, inline. */
export function RevitStart() {
  const rv = useRevit()
  return (
    <div className="revit-start" data-testid="revit-start">
      {rv.link.state === 'off' && !needsExplainer() ? (
        <button type="button" className="btn soft" data-testid="revit-connect-start" onClick={() => revit.connect()}>
          Open a sheet from Revit
        </button>
      ) : (
        <div className="revit-inline">
          <PanelBody close={() => {}} />
        </div>
      )}
    </div>
  )
}

const useCamera = () => useSyncExternalStore(subscribeCamera, getCamera)

/** M6-05: each linked command's result next to its ink: failed shows the message, notes show as a hint. */
export function RevitHud() {
  const rv = useRevit()
  const { commands, strokes, hidden } = useSession()
  const doc = useDocState()
  const cam = useCamera()
  if (!rv.open.length) return null
  const linked = new Set(rv.open.map((o) => o.id))
  const pls = new Map(doc.placements.map((p) => [p.sheetId, p]))
  const items = []
  for (const c of commands) {
    if (!linked.has(c.sheetId)) continue
    const e = entryFor(c.id)
    if (!e) continue
    const note = e.notes?.length && !rv.dismissed.has(c.id) ? e.notes.join(' · ') : undefined
    const show = e.status === 'failed' || e.status === 'sending' || (e.status === 'applied' && !e.landed) || note
    if (!show) continue
    const pl = pls.get(c.sheetId)
    const at = pl && anchorOf(c, strokes)
    if (!pl || !at) continue
    const s = sheetToScreen(cam, pl, at)
    const kind = e.status === 'failed' ? 'failed' : note ? 'note' : 'pending'
    const text = e.status === 'failed' ? (e.message ?? 'Revit could not apply this').replace(/^cmd-[\w-]+:\s*/, '') : note
    items.push(
      <div
        key={c.id}
        className={`revit-result ${kind}`}
        style={{ left: s.x + 10, top: s.y + 10 }}
        data-testid="revit-result"
        data-status={e.status}
        data-command-id={c.id}
        data-hidden-stroke={hidden.has(c.strokeId)}
        title={text ?? (e.status === 'sending' ? 'Sending to Revit…' : 'In Revit, waiting for the sheet')}
      >
        <span className="dot" aria-hidden="true" />
        {text && <span className="t">{text}</span>}
        {kind === 'note' && (
          <button type="button" aria-label="Dismiss" onClick={() => revit.dismissNote(c.id)}>
            ×
          </button>
        )}
      </div>,
    )
  }
  return <div className="revit-results">{items}</div>
}
