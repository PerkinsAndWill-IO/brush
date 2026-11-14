/**
 * App chrome from the design canvas: top bar, floating tool capsule, left
 * sidebar (tool options) and right sidebar (session list). M1 only — the
 * Reading panel, host status, latency readout and Live toggle arrive in M3.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DECISION_KINDS, type DecisionKind } from '@core/types'
import { useCameraZoom } from '../camera'
import { boardView } from '../board/Board'
import { getPlatform } from '../platform'
import { recorder, recorderAvailable, useRecorder } from '../recording'
import { session, useSession, type Tool } from '../session'
import { openFile, useDocState } from '../store'
import { BrushIcon, ChevronDown, ChevronRight, EraserIcon, PanIcon, RedoIcon, SelectIcon, UndoIcon } from './icons'

export async function chooseFile() {
  const f = await (await getPlatform()).openPdf()
  if (f) await openFile(f)
}

// ───────────── top bar ─────────────

const ZOOM_STEPS = [0.25, 0.5, 1, 2, 4]

function ZoomMenu() {
  const z = useCameraZoom()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  return (
    <div className="menu-anchor" ref={ref}>
      <button type="button" className="btn soft" aria-haspopup="menu" aria-expanded={open} aria-label={`Zoom, currently ${Math.round(z * 100)}%`} data-testid="zoom-button" onClick={() => setOpen(!open)}>
        <span className="mono-num">{Math.round(z * 100)}%</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => (boardView.fit(), setOpen(false))}>
            Fit all sheets <kbd>0</kbd>
          </button>
          {ZOOM_STEPS.map((s) => (
            <button key={s} type="button" role="menuitem" onClick={() => (boardView.zoomTo(s, undefined, { settleNow: true }), setOpen(false))}>
              {s * 100}%
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RecordToggle() {
  const rec = useRecorder()
  return (
    <div className="rec" data-testid="recorder">
      <button
        type="button"
        className={`chip-btn${rec.enabled ? ' on' : ''}`}
        aria-pressed={rec.enabled}
        data-testid="record-toggle"
        title="Dev only: record each stroke as a labeled fixture (M1-12)"
        onClick={() => recorder.setEnabled(!rec.enabled)}
      >
        <span className="rec-dot" aria-hidden="true" />
        {rec.enabled ? 'Recording' : 'Record'}
      </button>
      {rec.enabled && (
        <label className="rec-label">
          <span className="sr-only">Label for recorded strokes</span>
          <select value={rec.kind} data-testid="record-kind" onChange={(e) => recorder.setKind(e.target.value as DecisionKind)}>
            {DECISION_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

export function TopBar() {
  const doc = useDocState()
  const { canUndo, canRedo, saved } = useSession()
  const ready = doc.status === 'ready'
  return (
    <header className="topbar">
      <div className="title">
        <span className="project">{ready ? doc.fileName?.replace(/\.pdf$/i, '') : 'No drawing open'}</span>
        {ready && (
          <span className="secondary" data-testid="sheet-count">
            {doc.sheets.length} {doc.sheets.length === 1 ? 'sheet' : 'sheets'}
          </span>
        )}
        {ready && saved !== 'idle' && (
          <span className="secondary save-state" data-testid="save-state">
            {saved === 'pending' ? 'Saving…' : saved === 'saved' ? 'Saved' : 'Not saved'}
          </span>
        )}
      </div>
      <div className="actions">
        {ready && recorderAvailable() && <RecordToggle />}
        {ready && (
          <>
            <button type="button" className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => session.undo()}>
              <UndoIcon />
            </button>
            <button type="button" className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => session.redo()}>
              <RedoIcon />
            </button>
            <ZoomMenu />
          </>
        )}
        <button type="button" className="btn solid-white" onClick={() => void chooseFile()}>
          Open file
        </button>
      </div>
    </header>
  )
}

// ───────────── tool capsule ─────────────

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: <SelectIcon /> },
  { id: 'brush', label: 'Brush', key: 'B', icon: <BrushIcon /> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <EraserIcon /> },
  { id: 'pan', label: 'Pan', key: 'H', icon: <PanIcon /> },
]

export const INK_COLORS = [
  { hex: '#D7263D', name: 'red' },
  { hex: '#D12E7A', name: 'magenta' },
  { hex: '#1E55D9', name: 'blue' },
  { hex: '#1F8A4C', name: 'green' },
  { hex: '#1B1D21', name: 'black' },
]

function ColorButton({ disabled }: { disabled: boolean }) {
  const { settings } = useSession()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  const name = INK_COLORS.find((c) => c.hex.toLowerCase() === settings.color.toLowerCase())?.name ?? settings.color
  return (
    <div className="menu-anchor" ref={ref}>
      <button type="button" className="tool" aria-label={`Ink colour, ${name}`} aria-haspopup="true" aria-expanded={open} disabled={disabled} data-testid="ink-color" onClick={() => setOpen(!open)}>
        <span className="swatch" style={{ background: settings.color }} />
      </button>
      {open && (
        <div className="swatches" role="radiogroup" aria-label="Ink colour">
          {INK_COLORS.map((c) => (
            <button
              key={c.hex}
              type="button"
              role="radio"
              aria-checked={c.hex === settings.color}
              aria-label={c.name}
              className="tool"
              onClick={() => {
                session.setSetting('color', c.hex)
                setOpen(false)
              }}
            >
              <span className="swatch" style={{ background: c.hex }} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolCapsule({ disabled = false }: { disabled?: boolean }) {
  const { tool } = useSession()
  return (
    <nav className={`capsule${disabled ? ' disabled' : ''}`} aria-label={disabled ? 'Tools, unavailable until a drawing is open' : 'Tools'} data-testid="tool-capsule">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tool${!disabled && tool === t.id ? ' selected' : ''}`}
          aria-label={!disabled && tool === t.id ? `${t.label}, selected` : t.label}
          aria-pressed={!disabled && tool === t.id}
          title={`${t.label} (${t.key})`}
          disabled={disabled}
          data-tool={t.id}
          onClick={() => session.setTool(t.id)}
        >
          {t.icon}
        </button>
      ))}
      <span className="divider" aria-hidden="true" />
      <ColorButton disabled={disabled} />
    </nav>
  )
}

// ───────────── sidebars ─────────────

function Section({ title, aside, defaultOpen = true, disabled = false, testId, children }: { title: string; aside?: ReactNode; defaultOpen?: boolean; disabled?: boolean; testId?: string; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`section${disabled ? ' coming-later' : ''}`} data-testid={testId} data-open={open}>
      <h2>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight open={open} />
          {title}
          {aside && <span className="aside">{aside}</span>}
        </button>
      </h2>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}

function Slider({ id, label, value, min, max, step = 1, display, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; display: string; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <div className="field-row">
        <label htmlFor={id}>{label}</label>
        <span className="mono-num">{display}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  )
}

const ComingLater = ({ when }: { when: string }) => (
  <span className="later-tag" title={`Arrives in ${when}`}>
    Coming later
  </span>
)

const TOOL_META: Record<Tool, { label: string; icon: ReactNode }> = {
  select: { label: 'Select', icon: <SelectIcon /> },
  brush: { label: 'Brush', icon: <BrushIcon size={16} /> },
  eraser: { label: 'Eraser', icon: <EraserIcon size={16} /> },
  pan: { label: 'Pan', icon: <PanIcon size={16} /> },
}

export function LeftSidebar() {
  const { tool, settings, eraserSize } = useSession()
  const meta = TOOL_META[tool]
  return (
    <aside className="sidebar left" aria-label={`${meta.label} options`} data-testid="left-sidebar">
      <div className="tool-head">
        <span className="tool-badge" aria-hidden="true">
          {meta.icon}
        </span>
        <span className="tool-name">{meta.label}</span>
      </div>

      {tool === 'brush' && (
        <Section title="Stroke" testId="section-stroke">
          <Slider id="brush-size" label="Size" value={settings.size} min={1} max={24} display={`${settings.size} px`} onChange={(v) => session.setSetting('size', v)} />
          <Slider
            id="brush-smoothing"
            label="Smoothing"
            value={Math.round(settings.smoothing * 100)}
            min={0}
            max={100}
            display={`${Math.round(settings.smoothing * 100)}%`}
            onChange={(v) => session.setSetting('smoothing', v / 100)}
          />
        </Section>
      )}
      {tool === 'eraser' && (
        <Section title="Eraser" testId="section-eraser">
          <Slider id="eraser-size" label="Size" value={eraserSize} min={4} max={64} display={`${eraserSize} px`} onChange={(v) => session.setSetting('eraserSize', v)} />
          <p className="hint">Removes every stroke it touches. Undo brings them back.</p>
        </Section>
      )}
      {(tool === 'select' || tool === 'pan') && (
        <div className="section-body hint-block">
          <p className="hint">{tool === 'pan' ? 'Drag to move around the board. Ctrl-scroll or pinch to zoom.' : 'Nothing to select yet. Selection arrives with predictions.'}</p>
        </div>
      )}

      <Section title="Mode" aside={<ComingLater when="M3" />} disabled testId="section-mode">
        <span className="secondary">What the brush creates</span>
        <div className="mode-grid">
          {(['Auto', 'Wall', 'Door', 'Furniture', 'Markup'] as const).map((m) => (
            <button key={m} type="button" disabled aria-pressed={m === 'Auto'} className={`mode-btn${m === 'Auto' ? ' on' : ''}`}>
              {m}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Snapping" aside={<ComingLater when="M2" />} defaultOpen={false} disabled testId="section-snapping">
        {['Grid lines', 'Wall ends', '45° angles'].map((s) => (
          <button key={s} type="button" disabled className="toggle-row" aria-pressed={false}>
            {s}
            <span className="switch" aria-hidden="true">
              <span />
            </span>
          </button>
        ))}
      </Section>
      <Section title="Commit" aside={<ComingLater when="M3" />} defaultOpen={false} disabled testId="section-commit">
        <label htmlFor="brush-pause">Commit after pause</label>
        <input id="brush-pause" type="range" min={100} max={1500} defaultValue={400} disabled />
      </Section>
    </aside>
  )
}

function SessionList() {
  const { strokes } = useSession()
  const doc = useDocState()
  const names = new Map(doc.sheets.map((s) => [s.id, s.number ?? s.name]))
  const list = strokes.slice(-50).reverse()
  return (
    <ol className="session-list" data-testid="session-list">
      {list.length === 0 && <li className="empty-row">No strokes yet. Pick the brush and draw on a sheet.</li>}
      {list.map((s) => {
        const n = strokes.indexOf(s) + 1
        return (
          <li key={s.id} data-stroke-id={s.id}>
            <span className="swatch sm" style={{ background: s.color ?? '#D7263D' }} aria-hidden="true" />
            <div className="row-text">
              <span className="row-title">Stroke {n}</span>
              <span className="secondary">
                {names.get(s.sheetId)} · {s.points.length} pts
              </span>
            </div>
            <span className="row-status">Ink</span>
          </li>
        )
      })}
      {strokes.length > 50 && <li className="empty-row">and {strokes.length - 50} earlier strokes</li>}
    </ol>
  )
}

function RecordingsList() {
  const rec = useRecorder()
  if (!rec.enabled && rec.items.length === 0) return null
  return (
    <Section title="Recordings" aside={<span className="dev-tag">dev</span>} testId="section-recordings">
      <ol className="session-list" data-testid="recordings-list">
        {rec.items.length === 0 && <li className="empty-row">Each stroke you draw now is recorded as “{rec.kind}”.</li>}
        {rec.items
          .slice()
          .reverse()
          .map((r) => (
            <li key={r.fileName}>
              <div className="row-text">
                <span className="row-title mono-num">{r.fileName}</span>
                <span className="secondary">
                  {r.recording.label.kind} · sheet {r.recording.sheet + 1} · {r.recording.points.length} pts
                </span>
              </div>
              <button type="button" className="link-btn" data-testid="save-recording" onClick={() => void recorder.save(r.fileName)}>
                {r.saved ? 'Saved' : 'Save'}
              </button>
            </li>
          ))}
      </ol>
    </Section>
  )
}

export function RightSidebar() {
  const { strokes } = useSession()
  return (
    <aside className="sidebar right" aria-label="Inspector" data-testid="right-sidebar">
      <Section title="This session" aside={`${strokes.length} ${strokes.length === 1 ? 'stroke' : 'strokes'}`} testId="section-session">
        <SessionList />
      </Section>
      {recorderAvailable() && <RecordingsList />}
    </aside>
  )
}
