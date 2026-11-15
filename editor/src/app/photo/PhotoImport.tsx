/**
 * "Import photo": the dialog for bringing hand markup in from a photo of a printed sheet (task P1). It is opened
 * from the app menu (ui/Chrome.tsx) or by dropping an image on an open drawing.
 * The work itself is in ./import.ts; this file is the UI state around one import.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { XIcon } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { cn } from '@/lib/utils'
import type { Sheet } from '@core/types'
import { getDocState, useDocState } from '../store'
import { makeElements } from './groupActions'
import { PhotoImportError, importPhotoMarkup, type PhotoImportSummary } from './import'
import type { InkChoice } from './pipeline'
import { MAX_AUTO_SHEETS, knownSheetId, sheetLabel } from './plan'

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
  lines: string[]
  summary?: PhotoImportSummary
  error?: string
}

const CLOSED: DialogState = { open: false, phase: 'pick', file: null, sheetId: '', sheetDoc: 0, printed: null, askPrinted: false, ink: 'both', lines: [] }
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
    set({ ...CLOSED, open: true, file: file ?? null, sheetId, sheetDoc: doc.loadId, printed: same ? state.printed : null, ink: state.ink })
  },
  close() {
    abort?.abort()
    abort = null
    set({ ...CLOSED, sheetId: state.sheetId, sheetDoc: state.sheetDoc, printed: state.printed, ink: state.ink })
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
    set({ phase: 'running', lines: [], error: undefined, summary: undefined })
    try {
      const summary = await importPhotoMarkup(file, {
        sheetId,
        printed: printed ?? undefined,
        ink,
        signal: ac.signal,
        onProgress: (line) => !ac.signal.aborted && set({ lines: [...state.lines, line].slice(-200) }),
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

/** The right-hand control of a dialog row: a file button or a select, 40 px high, at most 62% of the row. */
const PICK = 'block h-10 max-w-[62%] min-w-0 truncate rounded-xl bg-background px-3 text-left font-normal'
const SELECT = 'max-w-[62%] min-w-0 [&_select]:h-10 [&_select]:rounded-xl [&_select]:bg-background'

function SheetSelect({ sheets, value, printed }: { sheets: Sheet[]; value: string; printed: boolean }) {
  // a sheet that is gone (another file was opened) falls back to automatic
  const known = value === '' || sheets.some((s) => s.id === value)
  return (
    <label className="field">
      <span>{printed ? 'Strokes go on' : 'Sheet in the photo'}</span>
      <NativeSelect className={SELECT} data-testid="photo-sheet" value={known ? value : ''} onChange={(e) => set({ sheetId: e.target.value })}>
        <NativeSelectOption value="">{sheets.length > MAX_AUTO_SHEETS ? `Find it (first ${MAX_AUTO_SHEETS} sheets)` : 'Find it automatically'}</NativeSelectOption>
        {sheets.map((s) => (
          <NativeSelectOption key={s.id} value={s.id}>
            {sheetLabel(s)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
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
    <Dialog open onOpenChange={(open) => !open && photoImport.close()}>
      <DialogContent
        className="modal flex max-h-[calc(100%-48px)] flex-col gap-3.5 overflow-auto rounded-[20px] bg-card p-[22px] pb-[18px] shadow-2xl sm:max-w-[460px]"
        aria-describedby={undefined}
        data-testid="photo-import"
        data-phase={st.phase}
        // a click outside cancels, but not while the import runs (Cancel or Escape stop it)
        onInteractOutside={(e) => running && e.preventDefault()}
      >
        <DialogTitle className="text-[15px] font-semibold tracking-tight">Import markup from a photo</DialogTitle>

        {st.phase === 'pick' && (
          <>
            <p>
              Photograph the printed sheet with the pen or marker markup on it, flat and in focus. The markup is traced, lined up with the drawing and added as brush strokes.
            </p>
            <div className="field">
              <span>Photo</span>
              <Button variant="outline" className={PICK} data-testid="photo-choose" onClick={() => input.current?.click()}>
                {st.file ? st.file.name : 'Choose photo…'}
              </Button>
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
                  <Button variant="outline" className={cn(PICK, 'max-w-none')} data-testid="photo-printed-choose" onClick={() => printedInput.current?.click()}>
                    {st.printed.name}
                  </Button>
                  <Button variant="outline" size="icon-lg" className="size-10 rounded-xl bg-background" aria-label="Match the open drawing instead" data-testid="photo-printed-clear" onClick={() => set({ printed: null, error: undefined })}>
                    <XIcon />
                  </Button>
                </span>
              </div>
            )}
            <SheetSelect sheets={doc.sheets} value={st.sheetId} printed={!!st.printed} />
            <label className="field">
              <span>Pens to pick up</span>
              <NativeSelect className={SELECT} data-testid="photo-ink" value={st.ink} onChange={(e) => set({ ink: e.target.value as InkChoice })}>
                <NativeSelectOption value="both">All pens and markers</NativeSelectOption>
                <NativeSelectOption value="color">Coloured only</NativeSelectOption>
                <NativeSelectOption value="dark">Black pen and pencil only</NativeSelectOption>
              </NativeSelect>
            </label>
            {st.error && (
              <Alert variant="destructive" className="error" data-testid="photo-error">
                <AlertDescription className="text-destructive">
                  {st.error}
                  {st.askPrinted && !st.printed && (
                    <Button className="mt-2.5 flex" data-testid="photo-ask-printed" onClick={() => printedInput.current?.click()}>
                      Choose the printed PDF…
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            <DialogFooter className="modal-actions -mx-[22px] -mb-[18px] mt-1 rounded-b-[20px] px-[22px] py-3.5">
              <Button variant="outline" size="touch" onClick={() => photoImport.close()}>
                Cancel
              </Button>
              <Button size="touch" className="px-5 font-semibold" data-testid="photo-run" disabled={!st.file} onClick={() => void photoImport.run()}>
                Import
              </Button>
            </DialogFooter>
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
            <DialogFooter className="modal-actions -mx-[22px] -mb-[18px] mt-1 rounded-b-[20px] px-[22px] py-3.5">
              <Button variant="outline" size="touch" onClick={() => photoImport.close()}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        )}

        {st.phase === 'done' && st.summary && (
          <>
            <Summary s={st.summary} />
            <DialogFooter className="modal-actions -mx-[22px] -mb-[18px] mt-1 rounded-b-[20px] px-[22px] py-3.5">
              <Button variant="outline" size="touch" onClick={() => photoImport.open()}>
                Import another
              </Button>
              {st.summary.strokes > 0 && (
                <Button
                  variant="outline"
                  size="touch"
                  data-testid="photo-make-elements"
                  title="Read the imported strokes the way the brush reads a stroke, and turn the ones it is sure of into elements"
                  onClick={() => {
                    const id = st.summary?.groupId
                    photoImport.close()
                    if (id) void makeElements(id).catch(() => undefined)
                  }}
                >
                  Make elements
                </Button>
              )}
              <Button size="touch" className="px-5 font-semibold" data-testid="photo-done" onClick={() => photoImport.close()}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
