/**
 * "Import photo": the dialog for bringing hand markup in from a photo of a printed sheet (task P1). It is opened
 * from the app menu (ui/Chrome.tsx) or by dropping an image on an open drawing.
 * The work itself is in ./import.ts; this file is the UI state around one import.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Sheet } from '@core/types'
import { getDocState, useDocState } from '../store'
import { makeElements } from './groupActions'
import { PhotoImportError, importPhotoMarkup, type PhotoImportSummary } from './import'
import type { InkChoice } from './pipeline'
import { PhoneQr } from './PhoneQr'
import { MAX_AUTO_SHEETS, knownSheetId, sheetLabel } from './plan'
import { firstGlance, peekPreference } from './peek'
import { PhotoProgress } from './PhotoProgress'
import { advanceStage, sheetOfLine, type ImportStage } from './progress'

type Phase = 'pick' | 'running' | 'done'

interface DialogState {
  open: boolean
  phase: Phase
  file: File | null
  /** '' = find the sheet automatically. */
  sheetId: string
  /** The document load (`DocState.loadId`) the sheet choice was made for; it is not carried to another document. */
  sheetDoc: number
  /** P1-09: the file the paper in the photo was printed from, when not the open one. Kept like the sheet choice. */
  printed: File | null
  /** The last import matched no open sheet: offer to match the printed file instead (P1-09). */
  askPrinted: boolean
  ink: InkChoice
  /** P1-11: the QR code for sending the photo from a phone is shown. */
  phone: boolean
  lines: string[]
  /** P1-13: where the running import is, as the dialog tells it. */
  stage: ImportStage
  startedAt: number
  stageAt: number
  /** The sheet being compared while finding it. */
  probing?: string
  /** Ask the hosted model for a first glance at the photo while it is read (opt-in, remembered). */
  peek: boolean
  /** undefined = not asked; null = waiting. */
  glance?: string | null
  summary?: PhotoImportSummary
  error?: string
}

const CLOSED: DialogState = { open: false, phase: 'pick', file: null, sheetId: '', sheetDoc: 0, printed: null, askPrinted: false, ink: 'both', phone: false, lines: [], stage: 'develop', startedAt: 0, stageAt: 0, peek: peekPreference.get() }
let state: DialogState = CLOSED
let abort: AbortController | null = null
const listeners = new Set<() => void>()

function set(next: Partial<DialogState>) {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Image files are photos of markup, not drawings to open. */
export const isPhotoFile = (f: { name: string; type?: string }): boolean => /^image\//.test(f.type ?? '') || /\.(jpe?g|png|webp|heic|heif|avif|bmp|gif)$/i.test(f.name)

export const photoImport = {
  /** Open the dialog, optionally with a photo already chosen (a drop). */
  open(file?: File) {
    if (state.phase === 'running') return
    // a sheet chosen for another document is forgotten: sheet ids repeat across PDFs ("sheet-2"), so a stale
    // choice would otherwise force the photo onto the wrong sheet, or fail on a sheet that is gone
    const doc = getDocState()
    const same = state.sheetDoc === doc.loadId
    const sheetId = same ? (knownSheetId(doc.sheets, state.sheetId) ?? '') : ''
    set({ ...CLOSED, open: true, file: file ?? null, sheetId, sheetDoc: doc.loadId, printed: same ? state.printed : null, ink: state.ink, peek: state.peek })
  },
  close() {
    abort?.abort()
    abort = null
    set({ ...CLOSED, sheetId: state.sheetId, sheetDoc: state.sheetDoc, printed: state.printed, ink: state.ink, peek: state.peek })
  },
  async run() {
    const { file, ink } = state
    if (!file || state.phase === 'running') return
    // submit what the dialog shows: a choice that does not belong to the open document means "find it"
    const doc = getDocState()
    const same = state.sheetDoc === doc.loadId
    const sheetId = same ? knownSheetId(doc.sheets, state.sheetId) : undefined
    const printed = same ? state.printed : null
    if ((sheetId ?? '') !== state.sheetId || !same) set({ sheetId: sheetId ?? '', sheetDoc: doc.loadId, printed })
    const ac = new AbortController()
    abort = ac
    const t0 = performance.now()
    set({ phase: 'running', lines: [], error: undefined, summary: undefined, stage: 'develop', startedAt: t0, stageAt: t0, probing: undefined, glance: state.peek ? null : undefined })
    // P1-13: the first glance runs beside the import and never holds it up
    if (state.peek)
      void firstGlance(file, ac.signal).then((g) => {
        if (!ac.signal.aborted && state.phase === 'running') set({ glance: g ?? undefined })
      })
    const onLine = (line: string) => {
      const stage = advanceStage(state.stage, line)
      set({
        lines: [...state.lines, line].slice(-200),
        ...(stage !== state.stage ? { stage, stageAt: performance.now() } : {}),
        probing: sheetOfLine(line) ?? (stage === 'find' ? state.probing : undefined),
      })
    }
    try {
      const summary = await importPhotoMarkup(file, {
        sheetId,
        printed: printed ?? undefined,
        ink,
        signal: ac.signal,
        onProgress: (line) => !ac.signal.aborted && onLine(line),
      })
      if (!ac.signal.aborted) set({ phase: 'done', summary, askPrinted: false })
    } catch (e) {
      if (ac.signal.aborted) return
      console.warn('photo import failed', e)
      // matched none of the open sheets: only now is the printed file asked for (P1-09)
      const askPrinted = !printed && e instanceof PhotoImportError && e.code === 'no-match'
      set({ phase: 'pick', error: (e as Error).message || String(e), askPrinted: askPrinted || (!!printed && state.askPrinted) })
    } finally {
      if (abort === ac) abort = null
    }
  },
}

function SheetSelect({ sheets, value, printed }: { sheets: Sheet[]; value: string; printed: boolean }) {
  // a sheet that is gone (another file was opened) falls back to automatic
  const known = value === '' || sheets.some((s) => s.id === value)
  return (
    <label className="field">
      <span>{printed ? 'Strokes go on' : 'Sheet in the photo'}</span>
      <select data-testid="photo-sheet" value={known ? value : ''} onChange={(e) => set({ sheetId: e.target.value })}>
        <option value="">{sheets.length > MAX_AUTO_SHEETS ? `Find it (first ${MAX_AUTO_SHEETS} sheets)` : 'Find it automatically'}</option>
        {sheets.map((s) => (
          <option key={s.id} value={s.id}>
            {sheetLabel(s)}
          </option>
        ))}
      </select>
    </label>
  )
}

function Summary({ s }: { s: PhotoImportSummary }) {
  if (!s.strokes) {
    return (
      <p data-testid="photo-summary">
        The photo matches <b>{s.sheetLabel}</b>, but no pen or marker ink was found on it. Faint pencil and ink the same colour as the print are hard to tell from the drawing.
      </p>
    )
  }
  return (
    <>
      <p data-testid="photo-summary">
        Added <b>{s.strokes}</b> {s.strokes === 1 ? 'stroke' : 'strokes'} to <b>{s.sheetLabel}</b>
        {s.printedFrom && (
          <>
            {' '}
            (traced against <b>{s.printedFrom}</b>)
          </>
        )}
        . They are grouped under This session, where they can be removed or made into elements together.
      </p>
      <ul className="ink-list">
        {s.layers.map((l) => (
          <li key={l.name}>
            <span className="swatch" style={{ background: l.color }} />
            {l.name} <span className="mono-num">{l.strokes}</span>
          </li>
        ))}
      </ul>
      <p className="secondary">
        {s.residualMm !== undefined && `Placed to within about ${Math.max(0.1, s.residualMm).toFixed(1)} mm on the sheet. `}
        {s.coverage !== undefined && `The photo covers ${Math.round(s.coverage * 100)}% of the sheet. `}
        Took {(s.ms / 1000).toFixed(0)} s.
      </p>
    </>
  )
}

export function PhotoImportDialog() {
  const st = useSyncExternalStore(subscribe, () => state)
  const doc = useDocState()
  const input = useRef<HTMLInputElement>(null)
  const printedInput = useRef<HTMLInputElement>(null)
  const ready = doc.status === 'ready'
  // the chosen photo, shown on the light table while it is read
  const photoUrl = useMemo(() => (st.file ? URL.createObjectURL(st.file) : null), [st.file])
  useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl])

  useEffect(() => {
    if (!st.open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        photoImport.close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [st.open])

  // the document went away under the dialog
  useEffect(() => {
    if (st.open && !ready) photoImport.close()
  }, [st.open, ready])

  if (!st.open || !ready) return null
  const running = st.phase === 'running'
  // P1-12: after an import that added strokes the dialog steps aside to a card, so the trace can be seen unrolling
  const aside = st.phase === 'done' && !!st.summary?.strokes
  return (
    <div className={`modal-backdrop${aside ? ' aside' : ''}`} onPointerDown={(e) => e.target === e.currentTarget && !running && photoImport.close()}>
      <div className={`modal${running ? ' running' : ''}${aside ? ' aside' : ''}`} role="dialog" aria-modal={!aside} aria-labelledby="photo-import-title" data-testid="photo-import" data-phase={st.phase}>
        <h2 id="photo-import-title">{running ? 'Reading your markup' : aside ? 'Markup on trace' : 'Import markup from a photo'}</h2>

        {st.phase === 'pick' && (
          <>
            <p>
              Photograph the printed sheet with the pen or marker markup on it, flat and in focus. The markup is traced, lined up with the drawing and added as brush strokes.
            </p>
            <div className="field">
              <span>Photo</span>
              <span className="field-pair">
                <button type="button" className="btn soft" data-testid="photo-choose" onClick={() => input.current?.click()}>
                  {st.file ? st.file.name : 'Choose photo…'}
                </button>
                <button
                  type="button"
                  className={`btn soft phone-toggle${st.phone ? ' on' : ''}`}
                  aria-pressed={st.phone}
                  data-testid="photo-phone"
                  title="Send the photo from your phone: scan a QR code"
                  onClick={() => set({ phone: !st.phone })}
                >
                  From phone
                </button>
              </span>
              <input
                ref={input}
                type="file"
                accept="image/*,.heic,.heif"
                hidden
                data-testid="photo-file"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) set({ file: f, error: undefined })
                  e.target.value = ''
                }}
              />
            </div>
            {st.phone && <PhoneQr onPhoto={(f) => set({ file: f, phone: false, error: undefined })} />}
            {/* P1-09: asked for only after the photo matched none of the open sheets */}
            <input
              ref={printedInput}
              type="file"
              accept=".pdf,.drawing,application/pdf"
              hidden
              data-testid="photo-printed-file"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                set({ printed: f, sheetDoc: getDocState().loadId, error: undefined })
                // the photo is chosen already: try again, now against the printed file
                if (state.file) void photoImport.run()
              }}
            />
            {st.printed && (
              <div className="field" title="The photo is matched to this file; the strokes go on the open sheet with the same layout.">
                <span>Printed from</span>
                <span className="field-pair">
                  <button type="button" className="btn soft" data-testid="photo-printed-choose" onClick={() => printedInput.current?.click()}>
                    {st.printed.name}
                  </button>
                  <button type="button" className="btn soft clear" aria-label="Match the open drawing instead" data-testid="photo-printed-clear" onClick={() => set({ printed: null, error: undefined })}>
                    ×
                  </button>
                </span>
              </div>
            )}
            <SheetSelect sheets={doc.sheets} value={st.sheetId} printed={!!st.printed} />
            <label className="field">
              <span>Pens to pick up</span>
              <select data-testid="photo-ink" value={st.ink} onChange={(e) => set({ ink: e.target.value as InkChoice })}>
                <option value="both">All pens and markers</option>
                <option value="color">Coloured only</option>
                <option value="dark">Black pen and pencil only</option>
              </select>
            </label>
            <label className="check" title="Sends a small preview of the photo to the hosted model (AI Gateway). The tracing itself stays on this machine.">
              <input
                type="checkbox"
                data-testid="photo-peek"
                checked={st.peek}
                onChange={(e) => {
                  peekPreference.set(e.target.checked)
                  set({ peek: e.target.checked })
                }}
              />
              <span>
                Ask Claude for a first glance while it reads
                <small>Sends a small preview of the photo; the tracing stays on this machine.</small>
              </span>
            </label>
            {st.error && (
              <div className="error" role="alert" data-testid="photo-error">
                <p>{st.error}</p>
                {st.askPrinted && !st.printed && (
                  <button type="button" className="btn accent" data-testid="photo-ask-printed" onClick={() => printedInput.current?.click()}>
                    Choose the printed PDF…
                  </button>
                )}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" className="btn soft" onClick={() => photoImport.close()}>
                Cancel
              </button>
              <button type="button" className="btn accent" data-testid="photo-run" disabled={!st.file} onClick={() => void photoImport.run()}>
                Import
              </button>
            </div>
          </>
        )}

        {running && (
          <>
            <PhotoProgress
              photoUrl={photoUrl}
              fileName={st.file?.name}
              view={{ stage: st.stage, startedAt: st.startedAt, stageAt: st.stageAt, sheet: st.probing, glance: st.glance, lines: st.lines }}
            />
            <div className="modal-actions">
              <button type="button" className="btn soft" onClick={() => photoImport.close()}>
                Cancel
              </button>
            </div>
          </>
        )}

        {st.phase === 'done' && st.summary && (
          <>
            <Summary s={st.summary} />
            <div className="modal-actions">
              <button type="button" className="btn soft" onClick={() => photoImport.open()}>
                Import another
              </button>
              {st.summary.strokes > 0 && (
                <button
                  type="button"
                  className="btn soft"
                  data-testid="photo-make-elements"
                  title="Read the imported strokes the way the brush reads a stroke, and turn the ones it is sure of into elements"
                  onClick={() => {
                    const id = st.summary?.groupId
                    photoImport.close()
                    if (id) void makeElements(id).catch(() => undefined)
                  }}
                >
                  Make elements
                </button>
              )}
              <button type="button" className="btn accent" data-testid="photo-done" onClick={() => photoImport.close()}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
