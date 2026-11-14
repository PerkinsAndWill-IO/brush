/**
 * "Import photo": the dialog for bringing hand markup in from a photo of a printed sheet (task P1). It is opened
 * from the app menu (ui/Chrome.tsx) or by dropping an image on an open drawing.
 * The work itself is in ./import.ts; this file is the UI state around one import.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Sheet } from '@core/types'
import { useDocState } from '../store'
import { importPhotoMarkup, type PhotoImportSummary } from './import'
import type { InkChoice } from './pipeline'
import { MAX_AUTO_SHEETS, sheetLabel } from './plan'

type Phase = 'pick' | 'running' | 'done'

interface DialogState {
  open: boolean
  phase: Phase
  file: File | null
  /** '' = find the sheet automatically. */
  sheetId: string
  ink: InkChoice
  lines: string[]
  summary?: PhotoImportSummary
  error?: string
}

const CLOSED: DialogState = { open: false, phase: 'pick', file: null, sheetId: '', ink: 'both', lines: [] }
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
    set({ ...CLOSED, open: true, file: file ?? null, sheetId: state.sheetId, ink: state.ink })
  },
  close() {
    abort?.abort()
    abort = null
    set({ ...CLOSED, sheetId: state.sheetId, ink: state.ink })
  },
  async run() {
    const { file, sheetId, ink } = state
    if (!file || state.phase === 'running') return
    const ac = new AbortController()
    abort = ac
    set({ phase: 'running', lines: [], error: undefined, summary: undefined })
    try {
      const summary = await importPhotoMarkup(file, {
        sheetId: sheetId || undefined,
        ink,
        signal: ac.signal,
        onProgress: (line) => !ac.signal.aborted && set({ lines: [...state.lines, line].slice(-200) }),
      })
      if (!ac.signal.aborted) set({ phase: 'done', summary })
    } catch (e) {
      if (ac.signal.aborted) return
      console.warn('photo import failed', e)
      set({ phase: 'pick', error: (e as Error).message || String(e) })
    } finally {
      if (abort === ac) abort = null
    }
  },
}

function SheetSelect({ sheets, value }: { sheets: Sheet[]; value: string }) {
  // a sheet that is gone (another file was opened) falls back to automatic
  const known = value === '' || sheets.some((s) => s.id === value)
  return (
    <label className="field">
      <span>Sheet in the photo</span>
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
        Added <b>{s.strokes}</b> {s.strokes === 1 ? 'stroke' : 'strokes'} to <b>{s.sheetLabel}</b>. Undo (Ctrl+Z) removes them in one step.
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
  const ready = doc.status === 'ready'

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
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !running && photoImport.close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="photo-import-title" data-testid="photo-import" data-phase={st.phase}>
        <h2 id="photo-import-title">Import markup from a photo</h2>

        {st.phase === 'pick' && (
          <>
            <p>
              Photograph the printed sheet with the pen or marker markup on it, flat and in focus. The markup is traced, lined up with the drawing and added as brush strokes.
            </p>
            <div className="field">
              <span>Photo</span>
              <button type="button" className="btn soft" data-testid="photo-choose" onClick={() => input.current?.click()}>
                {st.file ? st.file.name : 'Choose photo…'}
              </button>
              <input
                ref={input}
                type="file"
                accept="image/*"
                hidden
                data-testid="photo-file"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) set({ file: f, error: undefined })
                  e.target.value = ''
                }}
              />
            </div>
            <SheetSelect sheets={doc.sheets} value={st.sheetId} />
            <label className="field">
              <span>Pens to pick up</span>
              <select data-testid="photo-ink" value={st.ink} onChange={(e) => set({ ink: e.target.value as InkChoice })}>
                <option value="both">All pens and markers</option>
                <option value="color">Coloured only</option>
                <option value="dark">Black pen and pencil only</option>
              </select>
            </label>
            {st.error && (
              <p className="error" role="alert" data-testid="photo-error">
                {st.error}
              </p>
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
            <p>
              Reading <b>{st.file?.name}</b>. This takes from a few seconds to a minute, depending on the photo and the sheet.
            </p>
            <ol className="progress" aria-live="polite" data-testid="photo-progress">
              {st.lines.slice(-6).map((l, i) => (
                <li key={`${st.lines.length}-${i}`}>{l}</li>
              ))}
            </ol>
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
