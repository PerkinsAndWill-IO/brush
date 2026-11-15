/**
 * App chrome from the design canvas: top bar, floating tool capsule, left
 * sidebar (tool options) and right sidebar (session list). M1 only — the
 * Reading panel, host status, latency readout and Live toggle arrive in M3.
 */
import { useMemo, useState, type ComponentProps, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { DECISION_KINDS, type BrushMode, type DecisionKind } from '@core/types'
import { KIND_LABEL } from '../brain/overlays'
import { acceptReading } from '../brain/predictEngine'
import { commitPauseFor, useLive } from '../brain/live'
import { setSecondPassAdapter, useSecondPass } from '../brain/secondPass'
import type { RescoreAdapterSetting } from '@core/rescore'
import { useCameraZoom } from '../camera'
import { boardView } from '../board/Board'
import { getPlatform } from '../platform'
import { recorder, recorderAvailable, useRecorder } from '../recording'
import { getSession, session, sessionFileFor, useSession, useSessionField, type Tool } from '../session'
import { getDocState, openFile, useDocState } from '../store'
import { DrawingFileSource, buildCommandFile, commandFileName, serializeCommandFile, writeCommandFile } from '../source'
import { ITEM_KINDS, categoriesOf, filters, isAnnotationCategory, useFilters } from '../drawing/filters'
import { useContexts } from '../brain/contextStore'
import { BrushIcon, ChevronDown, ChevronRight, EraserIcon, MeasureIcon, MenuIcon, PanIcon, RedoIcon, SelectIcon, UndoIcon } from './icons'
import brushLogo from './assets/brush-logo.png'
import selectToolIcon from './assets/tool-select.png'
import brushToolIcon from './assets/tool-brush.png'
import eraserToolIcon from './assets/tool-eraser.png'
import panToolIcon from './assets/tool-pan.png'
import measureToolIcon from './assets/tool-measure.png'
import inkOutlineIcon from './assets/tool-ink-outline.png'
import photoToolIcon from './assets/tool-photo.png'
import inkPaintMask from './assets/tool-ink-paint.png'
import { LABEL_SCALES, sheetScale, useView, view } from '../view'
import { formatMetres, sheetDistanceMetres } from '../board/viewAids'
import { RevitButton } from '../revit/RevitPanel'
import { ElementPanel, useCanInspect } from '../drawing/InspectLayers'
import { useInspect } from '../drawing/inspect'
import { useRevit } from '../revit/controller'
import { photoImport } from '../photo/PhotoImport'
import { photoGroupOf, photoGroups, type PhotoGroup } from '../photo/groups'
import { makeElements, removePhotoGroup, usePhotoGroupUi } from '../photo/groupActions'

export async function chooseFile() {
  const f = await (await getPlatform()).openPdf()
  if (f) await openFile(f)
}

// ───────────── top bar ─────────────

const ZOOM_STEPS = [0.25, 0.5, 1, 2, 4]

function ZoomMenu() {
  const z = useCameraZoom()
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="touch" aria-label={`Zoom, currently ${Math.round(z * 100)}%`} data-testid="zoom-button">
          <span className="mono-num">{Math.round(z * 100)}%</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={() => boardView.fit()}>
          Fit all sheets
          <DropdownMenuShortcut>
            <Kbd>0</Kbd>
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {ZOOM_STEPS.map((s) => (
          <DropdownMenuItem key={s} className="font-mono" onSelect={() => boardView.zoomTo(s, undefined, { settleNow: true })}>
            {s * 100}%
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Plain PDFs have no host model; a `.drawing` package will report its host here (M5). */
function HostStatus() {
  const { source } = useDocState()
  const rv = useRevit()
  const pkg = source?.kind === 'package'
  if (rv.open.length)
    return (
      <Badge variant="secondary" className="pill h-7 gap-1.5 px-2.5 text-[11.5px] font-normal" data-testid="host-status" title="Edits go into the Revit model as you draw (M6)">
        <span className={`pill-dot${rv.link.state === 'on' ? ' live' : ''}`} aria-hidden="true" />
        {rv.link.state === 'on' ? `Live · ${rv.link.document?.title ?? 'Revit'}` : 'Revit offline · edits wait'}
      </Badge>
    )
  return (
    <Badge variant="secondary" className="pill h-7 gap-1.5 px-2.5 text-[11.5px] font-normal" data-testid="host-status" title="Commands go to the session log until an Applier links a host">
      <span className={`pill-dot${pkg ? ' pkg' : ''}`} aria-hidden="true" />
      {pkg ? `Package · ${source?.project ?? 'no project'}` : 'No host linked'}
    </Badge>
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

/**
 * Hamburger at the top right: file actions (open, import photo, save, export), the dev recorder and "Clear session".
 * Save stays open to show its result; the other actions close the menu.
 */
function AppMenu() {
  const doc = useDocState()
  const { commands, strokes } = useSession()
  const rec = useRecorder()
  const ready = doc.status === 'ready'
  const [open, setOpen] = useState(false)
  const [saveState, setSaveState] = useState<string | null>(null)
  const clearSession = () => {
    const n = strokes.length
    if (n && !window.confirm(`Clear this session? ${n} ${n === 1 ? 'stroke' : 'strokes'} and ${commands.length} ${commands.length === 1 ? 'command' : 'commands'} will be removed. This can't be undone.`)) return
    session.clear()
    view.clearMeasurements()
  }
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-touch" aria-label="Menu" data-testid="app-menu-button" title="Menu">
          <MenuIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" aria-label="Menu" data-testid="app-menu">
        <DropdownMenuItem data-testid="open-file" onSelect={() => void chooseFile()}>
          Open file…
          <DropdownMenuShortcut>
            <Kbd>Ctrl O</Kbd>
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        {ready && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="save-to-file"
              title="Write <name>.brush.json and <name>.commands.json to a folder you choose (downloads if your browser can't)"
              onSelect={(e) => {
                // stays open to show where the files went
                e.preventDefault()
                void saveToFiles().then((r) => {
                  setSaveState(r === 'disk' ? 'Saved to disk' : r === 'download' ? 'Downloaded' : null)
                  setTimeout(() => setSaveState(null), 2500)
                })
              }}
            >
              {saveState ?? 'Save to file'}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="export-commands" disabled={commands.length === 0} title="Save the command log as <name>.commands.json" onSelect={() => void exportCommands()}>
              Export commands
              <DropdownMenuShortcut className="font-mono">{commands.length}</DropdownMenuShortcut>
            </DropdownMenuItem>
            {recorderAvailable() && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={rec.enabled}
                  aria-pressed={rec.enabled}
                  data-testid="record-toggle"
                  title="Dev only: record each stroke as a labeled fixture (M1-12)"
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(v) => recorder.setEnabled(v)}
                >
                  <span className="menu-rec">
                    <span className={`rec-dot${rec.enabled ? ' on' : ''}`} aria-hidden="true" />
                    {rec.enabled ? 'Recording' : 'Record strokes'}
                  </span>
                  <DevBadge />
                </DropdownMenuCheckboxItem>
                {rec.enabled && (
                  <div className="flex items-center justify-between gap-3 px-1.5 py-1 text-sm">
                    <Label htmlFor="record-kind">Label</Label>
                    <NativeSelect id="record-kind" size="sm" value={rec.kind} data-testid="record-kind" onChange={(e) => recorder.setKind(e.target.value as DecisionKind)}>
                      {DECISION_KINDS.map((k) => (
                        <NativeSelectOption key={k} value={k}>
                          {k}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                )}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" data-testid="clear-session" disabled={strokes.length === 0} title="Remove every stroke and command for this drawing and start over" onSelect={clearSession}>
              Clear session
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The "dev" marker on developer-only controls. */
function DevBadge() {
  return (
    <Badge variant="destructive" className="dev-tag ml-auto h-4 px-1.5 font-mono text-[10.5px]">
      dev
    </Badge>
  )
}

function LatencyReadout() {
  const { lastFirstMs } = useLive()
  return (
    <Badge variant="secondary" className="pill h-7 gap-1.5 px-2.5 text-[11.5px] font-normal" data-testid="latency" title="Pen down to first guess on screen, last stroke">
      <span className="secondary">First guess</span>
      <span className="mono-num">{lastFirstMs === undefined ? '–' : `${Math.round(lastFirstMs)} ms`}</span>
    </Badge>
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
        {ready && <HostStatus />}
        <RevitButton />
        {ready && <LatencyReadout />}
        {ready && (
          <>
            <Button variant="ghost" size="icon-touch" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => session.undo()}>
              <UndoIcon />
            </Button>
            <Button variant="ghost" size="icon-touch" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => session.redo()}>
              <RedoIcon />
            </Button>
            <ZoomMenu />
          </>
        )}
        <AppMenu />
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
  const settings = useSessionField('settings')
  const [open, setOpen] = useState(false)
  const name = INK_COLORS.find((c) => c.hex.toLowerCase() === settings.color.toLowerCase())?.name ?? settings.color
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className={TOOL_BUTTON} aria-label={`Ink colour, ${name}`} disabled={disabled} data-testid="ink-color">
          {/* the paint in the can takes the current ink colour: an outline image under a mask filled with it */}
          <span className="ink-can" aria-hidden="true">
            <img className="tool-icon" src={inkOutlineIcon} alt="" />
            <span className="ink-paint" data-testid="ink-paint" style={{ backgroundColor: settings.color, maskImage: `url(${inkPaintMask})`, WebkitMaskImage: `url(${inkPaintMask})` }} />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={12} className="w-auto rounded-2xl p-1.5">
        <ToggleGroup
          type="single"
          spacing={0.5}
          aria-label="Ink colour"
          value={settings.color}
          onValueChange={(hex) => {
            if (hex) session.setSetting('color', hex)
            setOpen(false)
          }}
        >
          {INK_COLORS.map((c) => (
            <ToggleGroupItem key={c.hex} value={c.hex} aria-label={c.name} className="size-11 rounded-xl data-[state=on]:bg-muted">
              <span className="swatch" style={{ background: c.hex }} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </PopoverContent>
    </Popover>
  )
}

function LiveToggle({ disabled }: { disabled: boolean }) {
  const settings = useSessionField('settings')
  const on = settings.live && !disabled
  return (
    <Label className="live-toggle" title="Read strokes as you draw (off: plain ink)">
      <Switch
        checked={on}
        aria-label={`Live reading, ${on ? 'on' : 'off'}`}
        disabled={disabled}
        data-testid="live-toggle"
        onCheckedChange={(v) => session.setSetting('live', v)}
      />
      Live
    </Label>
  )
}

/** A capsule tool: the hand-drawn icons sit in bigger buttons than the shadcn defaults. */
const TOOL_BUTTON = 'size-[52px] rounded-2xl p-0 hover:bg-foreground/6 data-[state=on]:bg-accent data-[state=on]:hover:bg-accent'

export function ToolCapsule({ disabled = false }: { disabled?: boolean }) {
  const tool = useSessionField('tool')
  return (
    <nav className={`capsule${disabled ? ' disabled' : ''}`} aria-label={disabled ? 'Tools, unavailable until a drawing is open' : 'Tools'} data-testid="tool-capsule">
      {TOOLS.map((t) => (
        <Toggle
          key={t.id}
          className={TOOL_BUTTON}
          aria-label={!disabled && tool === t.id ? `${t.label}, selected` : t.label}
          pressed={!disabled && tool === t.id}
          title={`${t.label} (${t.key})`}
          disabled={disabled}
          data-tool={t.id}
          onPressedChange={() => session.setTool(t.id)}
        >
          {t.icon}
        </Toggle>
      ))}
      <Separator orientation="vertical" className="mx-1.5 h-6! bg-foreground/18" />
      <ColorButton disabled={disabled} />
      <Button
        variant="ghost"
        className={TOOL_BUTTON}
        aria-label="Import photo"
        title="Import markup from a photo: trace pen and marker on a photo of the printed sheet and add it as brush strokes"
        disabled={disabled}
        data-testid="import-photo"
        onClick={() => photoImport.open()}
      >
        <img className="tool-icon" src={photoToolIcon} alt="" />
      </Button>
      {!disabled && (
        <>
          <Separator orientation="vertical" className="mx-1.5 h-6! bg-foreground/18" />
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
    <Collapsible asChild open={open} onOpenChange={setOpen}>
      <section className={`section${disabled ? ' coming-later' : ''}`} data-testid={testId} data-open={open}>
        <h2>
          <CollapsibleTrigger asChild>
            <button type="button" className="hover:bg-foreground/4">
              <ChevronRight open={open} />
              {title}
              {aside && <span className="aside">{aside}</span>}
            </button>
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent className="section-body">{children}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}

function SliderField({ id, label, value, min, max, step = 1, display, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; display: string; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <div className="field-row">
        <Label className="font-normal">{label}</Label>
        <span className="mono-num">{display}</span>
      </div>
      <Slider id={id} className="h-6" thumbLabel={label} min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
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
  const settings = useSessionField('settings')
  const off = !settings.live
  return (
    <Section title="Mode" aside={off ? <LaterBadge>Live off</LaterBadge> : undefined} testId="section-mode">
      <span className="secondary">What the brush creates</span>
      <ToggleGroup
        type="single"
        spacing={1.5}
        className="grid w-full grid-cols-2"
        aria-label="Brush mode"
        disabled={off}
        value={settings.mode}
        onValueChange={(v) => v && session.setSetting('mode', v as BrushMode)}
      >
        {MODES.map((m) => (
          <ToggleGroupItem
            key={m.mode}
            value={m.mode}
            data-mode={m.mode}
            className={cn('h-11 bg-secondary hover:bg-background data-[state=on]:bg-primary data-[state=on]:font-semibold data-[state=on]:text-primary-foreground', m.mode === 'auto' && 'col-span-2')}
          >
            {m.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
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
      <Segmented type="single" aria-label="Second pass" disabled={disabled} value={sp.adapter} onValueChange={(v) => v && setSecondPassAdapter(v as RescoreAdapterSetting)}>
        {SECOND_PASS.map((o) => (
          <SegmentedItem key={o.id} value={o.id}>
            {o.label}
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  )
}

/** A settings row: its label, and a switch at the right. */
function SwitchRow({ label, on, onChange, testId, disabled }: { label: ReactNode; on: boolean; onChange: (v: boolean) => void; testId?: string; disabled?: boolean }) {
  return (
    <Label className="toggle-row font-normal">
      {label}
      <Switch checked={on} data-testid={testId} disabled={disabled} onCheckedChange={onChange} />
    </Label>
  )
}

/** A text action in a panel ("Remove", "Show all"): shadcn's link button, in the panel's 11 px. */
function LinkButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button variant="link" size="xs" className={cn('h-8 px-0 text-xs font-medium', className)} {...props} />
}

/** A small grey tag beside a section title ("Live off"). */
function LaterBadge({ children }: { children: ReactNode }) {
  return (
    <Badge variant="secondary" className="later-tag bg-muted font-medium text-muted-foreground">
      {children}
    </Badge>
  )
}

/** Segmented control: a toggle group laid out as equal tabs on a grey track. */
function Segmented(props: ComponentProps<typeof ToggleGroup>) {
  return <ToggleGroup spacing={0.5} {...props} className={cn('grid w-full auto-cols-fr grid-flow-col rounded-[10px] bg-muted p-0.5', props.className)} />
}

function SegmentedItem({ className, ...props }: ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn('h-10 min-w-0 rounded-lg px-1 text-xs font-medium hover:bg-background/60 data-[state=on]:bg-background data-[state=on]:shadow-xs data-[state=on]:hover:bg-background', className)}
      {...props}
    />
  )
}

function SnappingSection() {
  const settings = useSessionField('settings')
  const contextOverlay = useSessionField('contextOverlay')
  return (
    <Section title="Snapping" aside={settings.snapping ? `${settings.snapRadiusPt} pt` : 'off'} defaultOpen={false} testId="section-snapping">
      <SwitchRow label="Walls and grid lines" on={settings.snapping} onChange={(v) => session.setSetting('snapping', v)} testId="snap-toggle" />
      <SliderField
        id="snap-radius"
        label="Snap radius"
        value={settings.snapRadiusPt}
        min={2}
        max={24}
        display={`${settings.snapRadiusPt} pt`}
        onChange={(v) => session.setSetting('snapRadiusPt', v)}
      />
      {recorderAvailable() && (
        <SwitchRow
          label={
            <span className="flex items-center gap-1.5">
              Show detected context <DevBadge />
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
  const settings = useSessionField('settings')
  return (
    <Section title="Commit" aside={<span className="mono-num">{settings.commitPauseMs} ms</span>} defaultOpen={false} testId="section-commit">
      <SliderField
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
  const tool = useSessionField('tool')
  const settings = useSessionField('settings')
  const eraserSize = useSessionField('eraserSize')
  const canInspect = useCanInspect()
  const meta = TOOL_META[tool]
  return (
    <aside className={`sidebar left${tool === 'select' && canInspect ? ' wide' : ''}`} aria-label={`${meta.label} options`} data-testid="left-sidebar">
      <div className="tool-head">
        <span className="tool-badge" aria-hidden="true">
          {meta.icon}
        </span>
        <span className="tool-name">{meta.label}</span>
      </div>

      {tool === 'brush' && (
        <Section title="Stroke" testId="section-stroke">
          <SliderField id="brush-size" label="Size" value={settings.size} min={1} max={24} display={`${settings.size} px`} onChange={(v) => session.setSetting('size', v)} />
          <SliderField
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
          <SliderField id="eraser-size" label="Size" value={eraserSize} min={4} max={64} display={`${eraserSize} px`} onChange={(v) => session.setSetting('eraserSize', v)} />
          <p className="hint">Removes every stroke it touches. Undo brings them back.</p>
        </Section>
      )}
      {tool === 'pan' && (
        <div className="section-body hint-block">
          <p className="hint">Drag to move around the board. Ctrl-scroll or pinch to zoom.</p>
        </div>
      )}
      {tool === 'select' && <ElementSection />}

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
  // counting reads every page: wait until the background context pass has decoded them all
  const pending = [...useContexts().status.values()].includes('pending')
  const list = useMemo(() => (doc && !pending ? categoriesOf(doc) : []), [doc, pending])
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
        <Segmented
          type="multiple"
          aria-label="Item kinds"
          data-testid="filter-kinds"
          value={ITEM_KINDS.filter((k) => !f.hiddenKinds.has(k.kind)).map((k) => k.kind)}
          onValueChange={(shown) => ITEM_KINDS.forEach((k) => f.hiddenKinds.has(k.kind) === shown.includes(k.kind) && filters.setKindHidden(k.kind, !shown.includes(k.kind)))}
        >
          {ITEM_KINDS.map((k) => (
            <SegmentedItem key={k.kind} value={k.kind} data-kind={k.kind}>
              {k.label}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>
      <div className="field">
        <div className="field-row">
          <span>Categories</span>
        </div>
        <div className="filter-actions">
          {annotation.length > 0 && (
            <LinkButton data-testid="filter-annotation" onClick={() => filters.setCategoriesHidden(annotation, !annotationHidden)}>
              {annotationHidden ? 'Show annotation' : 'Hide annotation'}
            </LinkButton>
          )}
          <LinkButton data-testid="filter-reset" disabled={!hiddenHere} onClick={() => filters.reset()}>
            Show all
          </LinkButton>
        </div>
        <ul className="filter-list" data-testid="filter-categories">
          {list.map((c) => {
            const on = !f.hiddenCategories.has(c.name)
            return (
              <li key={c.name}>
                <Label className={on ? '' : 'off'}>
                  <Checkbox checked={on} data-category={c.name} onCheckedChange={(v) => filters.setCategoryHidden(c.name, v !== true)} />
                  <span className="filter-name">{c.name}</span>
                  <span className="secondary mono-num">{c.count}</span>
                </Label>
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
                  <LinkButton aria-label="Remove measurement" onClick={() => view.removeMeasurement(m.id)}>
                    Remove
                  </LinkButton>
                </li>
              )
            })}
          </ol>
          <LinkButton className="self-start" data-testid="measure-clear" onClick={() => view.clearMeasurements()}>
            Clear all
          </LinkButton>
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
      <SwitchRow label="Metric grid" on={grid} onChange={(v) => view.setGrid(v)} testId="grid-toggle" />
      <SwitchRow label="Scale bar" on={scaleBar} onChange={(v) => view.setScaleBar(v)} testId="scale-bar-toggle" />
      <div className="field">
        <div className="field-row">
          <span>Label size</span>
        </div>
        <Segmented
          type="single"
          aria-label="Label size"
          data-testid="label-size"
          value={String(labelScale)}
          onValueChange={(v) => {
            const o = LABEL_SCALES.find((x) => String(x.value) === v)
            if (o) view.setLabelScale(o.value)
          }}
        >
          {LABEL_SCALES.map((o) => (
            <SegmentedItem key={o.label} value={String(o.value)}>
              {o.label}
            </SegmentedItem>
          ))}
        </Segmented>
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
  // M3-11: a multi-stroke gesture is one row, on its last stroke
  const folded = new Set(Object.values(live.gestures).flatMap((ids) => ids.slice(0, -1)))
  // P1-07: a photo import is one row too, on its last stroke
  const groupAt = new Map(photoGroups(strokes, accepted).map((g) => [g.strokeIds[g.strokeIds.length - 1], g]))
  const rows = strokes.filter((s) => !folded.has(s.id) && (!photoGroupOf(s.id) || groupAt.has(s.id)))
  const list = rows.slice(-50).reverse()
  return (
    <ol className="session-list" data-testid="session-list">
      {list.length === 0 && <li className="empty-row">No strokes yet. Pick the brush and draw on a sheet.</li>}
      {list.map((s) => {
        const g = groupAt.get(s.id)
        if (g) return <PhotoGroupRow key={g.id} group={g} sheetName={names.get(g.sheetId)} />
        const n = strokes.indexOf(s) + 1
        const a = byStroke.get(s.id)
        const parts = live.gestures[s.id]?.filter((id) => strokes.some((x) => x.id === id)).length ?? 1
        const reading = !a && live.strokeId === s.id && ['drawing', 'pending', 'offer'].includes(live.phase)
        return (
          <li key={s.id} data-stroke-id={s.id} data-kind={a?.kind ?? 'ink'} data-strokes={parts}>
            <span className="swatch sm" style={{ background: a ? 'var(--brand)' : (s.color ?? '#D7263D') }} aria-hidden="true" />
            <div className="row-text">
              <span className="row-title">{a ? `1 ${a.kind}` : parts > 1 ? `Sketch · ${parts} strokes` : `Stroke ${n}`}</span>
              <span className="secondary">
                {a?.type ? `${a.type} · ` : ''}
                {names.get(s.sheetId)}
                {a ? (parts > 1 ? ` · ${parts} strokes` : '') : parts > 1 ? '' : ` · ${s.points.length} pts`}
              </span>
            </div>
            {reading ? <span className="row-status reading">Reading</span> : a ? <span className="row-status ok">Logged</span> : <span className="row-status">Ink</span>}
          </li>
        )
      })}
      {rows.length > 50 && <li className="empty-row">and {rows.length - 50} earlier strokes</li>}
    </ol>
  )
}

/** P1-07/08: all strokes of one photo import, with what can be done to them together. */
function PhotoGroupRow({ group: g, sheetName }: { group: PhotoGroup; sheetName?: string }) {
  const { busy, results, errors } = usePhotoGroupUi()
  const error = errors[g.id]
  const reading = busy.has(g.id)
  const r = results[g.id]
  const n = g.strokeIds.length
  const left = n - g.elements
  const kept = r ? r.unsure + r.ink : 0
  return (
    <li className="photo-group" data-testid="photo-group" data-group-id={g.id} data-kind="photo" data-strokes={n} data-elements={g.elements}>
      <span className="swatches-sm" aria-hidden="true">
        {(g.colors.length ? g.colors : ['#D7263D']).slice(0, 3).map((c) => (
          <span key={c} className="swatch sm" style={{ background: c }} />
        ))}
      </span>
      <div className="row-text">
        <span className="row-title">
          Photo import · {n} {n === 1 ? 'stroke' : 'strokes'}
        </span>
        <span className="secondary" data-testid="photo-group-status">
          {sheetName}
          {g.elements ? ` · ${g.elements} ${g.elements === 1 ? 'element' : 'elements'}` : ''}
          {r && kept ? ` · ${kept} kept as ink` : ''}
          {r && !r.elements && !g.elements ? ' · no elements found' : ''}
        </span>
        {error && (
          <span className="secondary error-text" role="alert">
            {error}
          </span>
        )}
        <span className="row-actions">
          <LinkButton
            data-testid="photo-group-elements"
            title="Read these strokes the way the brush reads a stroke, and turn the ones it is sure of into elements (one undo step)"
            disabled={reading || left === 0}
            onClick={() => void makeElements(g.id).catch(() => undefined)}
          >
            {reading ? 'Reading…' : left === 0 ? 'All elements' : 'Make elements'}
          </LinkButton>
          <LinkButton data-testid="photo-group-remove" title="Remove every stroke of this import (one undo step)" disabled={reading} onClick={() => removePhotoGroup(g.id)}>
            Remove
          </LinkButton>
        </span>
      </div>
    </li>
  )
}

function RecordingsList() {
  const rec = useRecorder()
  if (!rec.enabled && rec.items.length === 0) return null
  return (
    <Section title="Recordings" aside={<DevBadge />} testId="section-recordings">
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
              <LinkButton data-testid="save-recording" onClick={() => void recorder.save(r.fileName)}>
                {r.saved ? 'Saved' : 'Save'}
              </LinkButton>
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
                  : (live.gesture?.length ?? 1) > 1
                    ? `Reading ${live.gesture!.length} strokes together. Commits when you pause (${commitPauseFor(settings, live.gesture!.length)} ms)`
                    : `Commits when you pause (${settings.commitPauseMs} ms)`}
          </div>
        </>
      )}
    </Section>
  )
}

/** Element data (V3): the Select tool's panel in the left sidebar, on documents with host elements. */
function ElementSection() {
  const canInspect = useCanInspect()
  const { pinned } = useInspect()
  if (!canInspect)
    return (
      <div className="section-body hint-block" data-testid="section-inspect">
        <p className="hint">Element data is available on .drawing files and Revit sheets. PDFs carry no elements.</p>
      </div>
    )
  return (
    <section className="section element-section" data-testid="section-element" data-pinned={pinned}>
      <ElementPanel />
    </section>
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
