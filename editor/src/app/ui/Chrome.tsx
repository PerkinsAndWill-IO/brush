/**
 * App chrome from the design canvas: top bar, floating tool capsule, left
 * sidebar (tool options) and right sidebar (session list). M1 only — the
 * Reading panel, host status, latency readout and Live toggle arrive in M3.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DECISION_KINDS, type BrushMode, type DecisionKind } from '@core/types'
import { KIND_LABEL } from '../brain/overlays'
import { acceptReading } from '../brain/predictEngine'
import { useLive } from '../brain/live'
import { setSecondPassAdapter, useSecondPass } from '../brain/secondPass'
import type { RescoreAdapterSetting } from '@core/rescore'
import { useCameraZoom } from '../camera'
import { boardView } from '../board/Board'
import { getPlatform } from '../platform'
import { recorder, recorderAvailable, useRecorder } from '../recording'
import { getSession, session, sessionFileFor, useSession, type Tool } from '../session'
import { getDocState, openFile, useDocState } from '../store'
import { DrawingFileSource, buildCommandFile, commandFileName, serializeCommandFile, writeCommandFile } from '../source'
import { ITEM_KINDS, categoriesOf, filters, isAnnotationCategory, useFilters } from '../drawing/filters'
import { useContexts } from '../brain/contextStore'
import { BrushIcon, ChevronDown, ChevronRight, EraserIcon, MeasureIcon, PanIcon, RedoIcon, SelectIcon, UndoIcon } from './icons'
import brushLogo from './assets/brush-logo.png'
import selectToolIcon from './assets/tool-select.png'
import brushToolIcon from './assets/tool-brush.png'
import eraserToolIcon from './assets/tool-eraser.png'
import panToolIcon from './assets/tool-pan.png'
import measureToolIcon from './assets/tool-measure.png'
import inkToolIcon from './assets/tool-ink.png'
import { LABEL_SCALES, sheetScale, useView, view } from '../view'
import { formatMetres, sheetDistanceMetres } from '../board/viewAids'
import { RevitButton } from '../revit/RevitPanel'
import { useRevit } from '../revit/controller'

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

/** Plain PDFs have no host model; a `.drawing` package will report its host here (M5). */
function HostStatus() {
  const { source } = useDocState()
  const rv = useRevit()
  const pkg = source?.kind === 'package'
  if (rv.open.length)
    return (
      <span className="pill" data-testid="host-status" title="Edits go into the Revit model as you draw (M6)">
        <span className={`pill-dot${rv.link.state === 'on' ? ' live' : ''}`} aria-hidden="true" />
        {rv.link.state === 'on' ? `Live · ${rv.link.document?.title ?? 'Revit'}` : 'Revit offline · edits wait'}
      </span>
    )
  return (
    <span className="pill" data-testid="host-status" title="Commands go to the session log until an Applier links a host">
      <span className={`pill-dot${pkg ? ' pkg' : ''}`} aria-hidden="true" />
      {pkg ? `Package · ${source?.project ?? 'no project'}` : 'No host linked'}
    </span>
  )
}

/** Write the command log next to nothing yet: a download / platform save of `<name>.commands.json` (M5). */
export async function exportCommands(): Promise<string | null> {
  const d = getDocState()
  if (!d.source) return null
  const file = buildCommandFile({
    source: { name: d.source.name, kind: d.source.kind, project: d.source.project },
    sheets: d.sheets,
    commands: getSession().commands,
  })
  const platform = await getPlatform()
  return writeCommandFile((name, text) => platform.saveTextFile(name, text), file)
}

/**
 * "Save to file": the sidecar `<name>.brush.json` and `<name>.commands.json` written to disk through the
 * File System Access API after one folder permission (Chromium); otherwise both are downloaded.
 * The browser-storage autosave keeps running either way.
 */
export async function saveToFiles(): Promise<'disk' | 'download' | null> {
  const d = getDocState()
  if (!d.source || !d.fileName) return null
  const base = d.fileName.replace(/\.(pdf|drawing)$/i, '')
  const st = getSession()
  const sidecar = JSON.stringify(sessionFileFor({ name: d.fileName, size: d.fileSize ?? 0 }, st.strokes, st.accepted, st.commands), null, 2)
  const cmds = serializeCommandFile(buildCommandFile({ source: { name: d.source.name, kind: d.source.kind, project: d.source.project }, sheets: d.sheets, commands: st.commands }))
  const files = [
    { name: `${base}.brush.json`, text: sidecar },
    { name: commandFileName(d.source.name), text: cmds },
  ]
  const platform = await getPlatform()
  if (await platform.saveFilesToDisk?.(files)) return 'disk'
  for (const f of files) await platform.saveTextFile(f.name, f.text)
  return 'download'
}

function SaveButton() {
  const [state, setState] = useState<string | null>(null)
  return (
    <button
      type="button"
      className="btn soft"
      data-testid="save-to-file"
      title="Write <name>.brush.json and <name>.commands.json to a folder you choose (downloads if your browser can't)"
      onClick={() =>
        void saveToFiles().then((r) => {
          setState(r === 'disk' ? 'Saved to disk' : r === 'download' ? 'Downloaded' : null)
          setTimeout(() => setState(null), 2500)
        })
      }
    >
      {state ?? 'Save to file'}
    </button>
  )
}

function ExportButton() {
  const { commands } = useSession()
  return (
    <button
      type="button"
      className="btn soft"
      data-testid="export-commands"
      disabled={commands.length === 0}
      title="Save the command log as <name>.commands.json"
      onClick={() => void exportCommands()}
    >
      Export commands
      <span className="mono-num">{commands.length}</span>
    </button>
  )
}

function LatencyReadout() {
  const { lastFirstMs } = useLive()
  return (
    <span className="pill" data-testid="latency" title="Pen down to first guess on screen, last stroke">
      <span className="secondary">First guess</span>
      <span className="mono-num">{lastFirstMs === undefined ? '–' : `${Math.round(lastFirstMs)} ms`}</span>
    </span>
  )
}

export function TopBar() {
  const doc = useDocState()
  const { canUndo, canRedo, saved } = useSession()
  const ready = doc.status === 'ready'
  return (
    <header className="topbar">
      <div className="title">
        <img className="brand-logo" src={brushLogo} alt="Brush" />
        <span className="project">{ready ? doc.fileName?.replace(/\.(pdf|drawing)$/i, '') : 'No drawing open'}</span>
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
        {ready && <HostStatus />}
        <RevitButton />
        {ready && <LatencyReadout />}
        {ready && (
          <>
            <button type="button" className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => session.undo()}>
              <UndoIcon />
            </button>
            <button type="button" className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => session.redo()}>
              <RedoIcon />
            </button>
            <ZoomMenu />
            <SaveButton />
            <ExportButton />
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
  { id: 'select', label: 'Select', key: 'V', icon: <img className="tool-icon" src={selectToolIcon} alt="" /> },
  { id: 'brush', label: 'Brush', key: 'B', icon: <img className="tool-icon" src={brushToolIcon} alt="" /> },
  { id: 'eraser', label: 'Eraser', key: 'E', icon: <img className="tool-icon" src={eraserToolIcon} alt="" /> },
  { id: 'pan', label: 'Pan', key: 'H', icon: <img className="tool-icon" src={panToolIcon} alt="" /> },
  { id: 'measure', label: 'Measure', key: 'M', icon: <img className="tool-icon" src={measureToolIcon} alt="" /> },
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
      <button type="button" className="tool ink" aria-label={`Ink colour, ${name}`} aria-haspopup="true" aria-expanded={open} disabled={disabled} data-testid="ink-color" onClick={() => setOpen(!open)}>
        <img className="tool-icon" src={inkToolIcon} alt="" />
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

function LiveToggle({ disabled }: { disabled: boolean }) {
  const { settings } = useSession()
  const on = settings.live && !disabled
  return (
    <button
      type="button"
      className="live-toggle"
      aria-label={`Live reading, ${on ? 'on' : 'off'}`}
      aria-pressed={on}
      disabled={disabled}
      data-testid="live-toggle"
      title="Read strokes as you draw (off: plain ink)"
      onClick={() => session.setSetting('live', !settings.live)}
    >
      <span className={`switch${on ? ' on' : ''}`} aria-hidden="true">
        <span />
      </span>
      Live
    </button>
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
      {!disabled && (
        <>
          <span className="divider" aria-hidden="true" />
          <LiveToggle disabled={disabled} />
        </>
      )}
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


const TOOL_META: Record<Tool, { label: string; icon: ReactNode }> = {
  select: { label: 'Select', icon: <SelectIcon /> },
  brush: { label: 'Brush', icon: <BrushIcon size={16} /> },
  eraser: { label: 'Eraser', icon: <EraserIcon size={16} /> },
  pan: { label: 'Pan', icon: <PanIcon size={16} /> },
  measure: { label: 'Measure', icon: <MeasureIcon size={16} /> },
}

const MODES: { mode: BrushMode; label: string }[] = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'wall', label: 'Wall' },
  { mode: 'door', label: 'Door' },
  { mode: 'furniture', label: 'Furniture' },
  { mode: 'markup', label: 'Markup' },
]

function ModeSection() {
  const { settings } = useSession()
  const off = !settings.live
  return (
    <Section title="Mode" aside={off ? <span className="later-tag">Live off</span> : undefined} testId="section-mode">
      <span className="secondary">What the brush creates</span>
      <div className="mode-grid">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            disabled={off}
            aria-pressed={settings.mode === m.mode}
            data-mode={m.mode}
            className={`mode-btn${m.mode === 'auto' ? ' wide' : ''}${settings.mode === m.mode ? ' on' : ''}`}
            onClick={() => session.setSetting('mode', m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <SecondPassRow disabled={off} />
    </Section>
  )
}

const SECOND_PASS: { id: RescoreAdapterSetting; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'local', label: 'Local' },
  { id: 'hosted', label: 'Hosted' },
  { id: 'jev', label: 'Jev' },
]

/** M4: which model (if any) rescores ambiguous readings. Never blocks a stroke. */
function SecondPassRow({ disabled }: { disabled: boolean }) {
  const sp = useSecondPass()
  return (
    <div className="field" data-testid="second-pass">
      <div className="field-row">
        <span>Second pass</span>
        {sp.name?.startsWith('cassette') && <span className="secondary mono-num">{sp.name}</span>}
      </div>
      <div className="segmented" role="radiogroup" aria-label="Second pass">
        {SECOND_PASS.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={sp.adapter === o.id} disabled={disabled} className={sp.adapter === o.id ? 'on' : ''} onClick={() => setSecondPassAdapter(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Toggle({ label, on, onChange, testId, disabled }: { label: ReactNode; on: boolean; onChange: (v: boolean) => void; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" className="toggle-row" aria-pressed={on} data-testid={testId} disabled={disabled} onClick={() => onChange(!on)}>
      {label}
      <span className={`switch${on ? ' on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  )
}

function SnappingSection() {
  const { settings, contextOverlay } = useSession()
  return (
    <Section title="Snapping" aside={settings.snapping ? `${settings.snapRadiusPt} pt` : 'off'} defaultOpen={false} testId="section-snapping">
      <Toggle label="Walls and grid lines" on={settings.snapping} onChange={(v) => session.setSetting('snapping', v)} testId="snap-toggle" />
      <Slider
        id="snap-radius"
        label="Snap radius"
        value={settings.snapRadiusPt}
        min={2}
        max={24}
        display={`${settings.snapRadiusPt} pt`}
        onChange={(v) => session.setSetting('snapRadiusPt', v)}
      />
      {recorderAvailable() && (
        <Toggle
          label={
            <span>
              Show detected context <span className="dev-tag">dev</span>
            </span>
          }
          on={contextOverlay}
          onChange={(v) => session.setSetting('contextOverlay', v)}
          testId="context-overlay-toggle"
        />
      )}
    </Section>
  )
}

function CommitSection() {
  const { settings } = useSession()
  return (
    <Section title="Commit" aside={<span className="mono-num">{settings.commitPauseMs} ms</span>} defaultOpen={false} testId="section-commit">
      <Slider
        id="brush-pause"
        label="Commit after pause"
        value={settings.commitPauseMs}
        min={100}
        max={1500}
        step={50}
        display={`${settings.commitPauseMs} ms`}
        onChange={(v) => session.setSetting('commitPauseMs', v)}
      />
    </Section>
  )
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

      {tool === 'measure' && <MeasureSection />}

      <ModeSection />
      <SnappingSection />
      <CommitSection />
      <ViewSection />
    </aside>
  )
}

// ───────────── drawing filters (docs/tasks/V2-drawing-filters.md) ─────────────

/** Only for a binary `.drawing`: its items carry the element categories the filters work on. */
function FiltersSection() {
  const { source } = useDocState()
  const doc = source instanceof DrawingFileSource ? source.doc : null
  const list = useMemo(() => (doc ? categoriesOf(doc) : []), [doc])
  const f = useFilters()
  if (!doc) return null
  const hiddenHere = list.filter((c) => f.hiddenCategories.has(c.name)).length + f.hiddenKinds.size
  const annotation = list.map((c) => c.name).filter(isAnnotationCategory)
  const annotationHidden = annotation.length > 0 && annotation.every((n) => f.hiddenCategories.has(n))
  return (
    <Section title="Filters" aside={hiddenHere ? <span className="mono-num">{hiddenHere} hidden</span> : undefined} testId="section-filters">
      <div className="field">
        <div className="field-row">
          <span>Show</span>
        </div>
        <div className="segmented" role="group" aria-label="Item kinds" data-testid="filter-kinds">
          {ITEM_KINDS.map((k) => {
            const on = !f.hiddenKinds.has(k.kind)
            return (
              <button key={k.kind} type="button" aria-pressed={on} data-kind={k.kind} className={on ? 'on' : ''} onClick={() => filters.setKindHidden(k.kind, on)}>
                {k.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="field">
        <div className="field-row">
          <span>Categories</span>
        </div>
        <div className="filter-actions">
          {annotation.length > 0 && (
            <button type="button" className="link-btn" data-testid="filter-annotation" onClick={() => filters.setCategoriesHidden(annotation, !annotationHidden)}>
              {annotationHidden ? 'Show annotation' : 'Hide annotation'}
            </button>
          )}
          <button type="button" className="link-btn" data-testid="filter-reset" disabled={!hiddenHere} onClick={() => filters.reset()}>
            Show all
          </button>
        </div>
        <ul className="filter-list" data-testid="filter-categories">
          {list.map((c) => {
            const on = !f.hiddenCategories.has(c.name)
            return (
              <li key={c.name}>
                <label className={on ? '' : 'off'}>
                  <input type="checkbox" checked={on} data-category={c.name} onChange={(e) => filters.setCategoryHidden(c.name, !e.target.checked)} />
                  <span className="filter-name">{c.name}</span>
                  <span className="secondary mono-num">{c.count}</span>
                </label>
              </li>
            )
          })}
        </ul>
      </div>
      <p className="hint">Filters change only what is drawn. Hidden items still count for snapping and predictions. Remembered per browser.</p>
    </Section>
  )
}

// ───────────── view aids (docs/tasks/V1-view-aids.md) ─────────────

function MeasureSection() {
  const { measurements } = useView()
  const doc = useDocState()
  useContexts() // a scale found later relabels the list
  const names = new Map(doc.sheets.map((s) => [s.id, s.number ?? s.name]))
  return (
    <Section title="Measurements" aside={<span className="mono-num">{measurements.length}</span>} testId="section-measure">
      <p className="hint">Drag across a sheet, or click two points. Ends snap to walls and grid lines when snapping is on. Backspace removes the last one.</p>
      {measurements.length > 0 && (
        <>
          <ol className="measure-list" data-testid="measure-list">
            {measurements.map((m) => {
              const scale = sheetScale(m.sheetId)
              return (
                <li key={m.id}>
                  <span>
                    <span className="mono-num">{scale ? formatMetres(sheetDistanceMetres(m.a, m.b, scale)) : 'no scale'}</span> <span className="secondary">{names.get(m.sheetId)}</span>
                  </span>
                  <button type="button" className="link-btn" aria-label="Remove measurement" onClick={() => view.removeMeasurement(m.id)}>
                    Remove
                  </button>
                </li>
              )
            })}
          </ol>
          <button type="button" className="link-btn" data-testid="measure-clear" onClick={() => view.clearMeasurements()}>
            Clear all
          </button>
        </>
      )}
      <p className="hint">Measurements are a view aid: they are not saved or sent as commands.</p>
    </Section>
  )
}

function ViewSection() {
  const { grid, scaleBar, labelScale } = useView()
  return (
    <Section title="View" defaultOpen={false} testId="section-view">
      <Toggle label="Metric grid" on={grid} onChange={(v) => view.setGrid(v)} testId="grid-toggle" />
      <Toggle label="Scale bar" on={scaleBar} onChange={(v) => view.setScaleBar(v)} testId="scale-bar-toggle" />
      <div className="field">
        <div className="field-row">
          <span>Label size</span>
        </div>
        <div className="segmented" role="radiogroup" aria-label="Label size" data-testid="label-size">
          {LABEL_SCALES.map((o) => (
            <button key={o.label} type="button" role="radio" aria-checked={labelScale === o.value} className={labelScale === o.value ? 'on' : ''} onClick={() => view.setLabelScale(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">Grid and scale bar need the sheet scale (read from text like “1:100”).</p>
    </Section>
  )
}

function SessionList() {
  const { strokes, accepted } = useSession()
  const live = useLive()
  const byStroke = new Map(accepted.map((a) => [a.strokeId, a]))
  const doc = useDocState()
  const names = new Map(doc.sheets.map((s) => [s.id, s.number ?? s.name]))
  const list = strokes.slice(-50).reverse()
  return (
    <ol className="session-list" data-testid="session-list">
      {list.length === 0 && <li className="empty-row">No strokes yet. Pick the brush and draw on a sheet.</li>}
      {list.map((s) => {
        const n = strokes.indexOf(s) + 1
        const a = byStroke.get(s.id)
        const reading = !a && live.strokeId === s.id && ['drawing', 'pending', 'offer'].includes(live.phase)
        return (
          <li key={s.id} data-stroke-id={s.id} data-kind={a?.kind ?? 'ink'}>
            <span className="swatch sm" style={{ background: a ? 'var(--accent)' : (s.color ?? '#D7263D') }} aria-hidden="true" />
            <div className="row-text">
              <span className="row-title">{a ? `1 ${a.kind}` : `Stroke ${n}`}</span>
              <span className="secondary">
                {a?.type ? `${a.type} · ` : ''}
                {names.get(s.sheetId)}
                {a ? '' : ` · ${s.points.length} pts`}
              </span>
            </div>
            {reading ? <span className="row-status reading">Reading</span> : a ? <span className="row-status ok">Logged</span> : <span className="row-status">Ink</span>}
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

function fmtLength(pts: { x: number; y: number }[], scale: number): string | undefined {
  if (pts.length < 2) return undefined
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return `${((L / 72) * 0.0254 * scale).toFixed(2)} m`
}

function ReadingPanel() {
  const live = useLive()
  const { settings, commands } = useSession()
  const { contexts } = useContexts()
  const h = live.hypothesis
  const scale = live.sheetId ? contexts.get(live.sheetId)?.scale : undefined
  const status = !settings.live
    ? 'Off'
    : live.phase === 'committed'
      ? 'Committed'
      : live.phase === 'markup'
        ? 'Ink'
        : live.phase === 'idle'
          ? ''
          : 'Live'
  const rows = h ? [{ kind: h.kind, confidence: h.confidence }, ...h.alternatives].slice(0, 3) : []
  const pickable = live.phase === 'pending' || live.phase === 'offer'
  const cmd = live.decision ? commands.find((c) => c.strokeId === live.decision!.strokeId) : undefined
  const length = h && h.kind !== 'markup' && scale ? fmtLength(h.geometry.points, scale) : undefined
  return (
    <Section
      title="Reading your stroke"
      aside={
        status ? (
          <span className={`live-badge${status === 'Live' ? ' on' : ''}`} data-testid="reading-status">
            {status === 'Live' && <span className="dot" aria-hidden="true" />}
            {status}
          </span>
        ) : undefined
      }
      testId="section-reading"
    >
      {!settings.live ? (
        <p className="hint">Live reading is off. Strokes stay plain ink.</p>
      ) : !h ? (
        <p className="hint">Draw on a sheet. The brush reads the stroke while you draw and commits when you pause.</p>
      ) : (
        <>
          <div className="reading-rows" data-testid="reading-rows">
            {rows.map((r, i) => (
              <button
                key={r.kind}
                type="button"
                className={`reading-row${i === 0 ? ' lead' : ''}`}
                aria-pressed={i === 0}
                data-kind={r.kind}
                disabled={!pickable}
                onClick={() => acceptReading(r.kind)}
              >
                <span className="k">{KIND_LABEL[r.kind]}</span>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(r.confidence * 100)}%` }} />
                </span>
                <span className="mono-num pct">{Math.round(r.confidence * 100)}%</span>
              </button>
            ))}
          </div>
          <div className="rule" />
          <dl className="facts">
            {h.type && (
              <div>
                <dt>Type</dt>
                <dd>{h.type}</dd>
              </div>
            )}
            {length && (
              <div>
                <dt>Length</dt>
                <dd className="mono-num">{length}</dd>
              </div>
            )}
            <div>
              <dt>Snaps</dt>
              <dd>{[live.snapStart, live.snapEnd].filter(Boolean).map((x) => x!.kind.replace('-', ' ')).join(', ') || 'none'}</dd>
            </div>
            {live.shapeOnly && (
              <div>
                <dt>Context</dt>
                <dd>none, shape only</dd>
              </div>
            )}
            {cmd && (
              <div>
                <dt>Command</dt>
                <dd className="mono-num" data-testid="reading-command">
                  {cmd.op} {cmd.id}
                </dd>
              </div>
            )}
          </dl>
          <ul className="evidence" data-testid="reading-evidence">
            {(h.evidence ?? []).slice(0, 6).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          {live.asking && (
            <p className="hint second-note" data-testid="second-asking">
              <span className="model-dot" aria-hidden="true" /> Asking the second pass…
            </p>
          )}
          {live.origin === 'model' && live.phase !== 'committed' && (
            <p className="hint second-note">
              <span className="model-dot" aria-hidden="true" /> Reading refined by the second pass
            </p>
          )}
          {live.suggestion && (
            <p className="hint second-note" data-testid="second-suggestion">
              <span className="model-dot" aria-hidden="true" /> Second pass suggests {KIND_LABEL[live.suggestion.kind].toLowerCase()} ({Math.round(live.suggestion.confidence * 100)}%). The committed element stays.
            </p>
          )}
          <div className="commit-note" data-testid="commit-note">
            {live.phase === 'offer'
              ? 'Not sure. Pick a reading, or keep drawing to leave it as ink.'
              : live.phase === 'committed'
                ? `Committed as ${KIND_LABEL[live.decision!.kind].toLowerCase()}. Undo to revert.`
                : live.phase === 'markup'
                  ? 'Kept as ink'
                  : `Commits when you pause (${settings.commitPauseMs} ms)`}
          </div>
        </>
      )}
    </Section>
  )
}

export function RightSidebar() {
  const { strokes } = useSession()
  return (
    <aside className="sidebar right" aria-label="Inspector" data-testid="right-sidebar">
      <ReadingPanel />
      <Section title="This session" aside={`${strokes.length} ${strokes.length === 1 ? 'stroke' : 'strokes'}`} testId="section-session">
        <SessionList />
      </Section>
      <FiltersSection />
      {recorderAvailable() && <RecordingsList />}
    </aside>
  )
}
