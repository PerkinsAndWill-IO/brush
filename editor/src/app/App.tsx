/**
 * App shell: top bar, sidebars, the board (or the empty state) and the tool
 * capsule. Layout and look follow docs/design/project/{Main,Empty}.dc.html.
 */
import { lazy, Suspense, useEffect, useState, type CSSProperties, type DragEvent } from 'react'
import samples from 'virtual:brush-samples'
import { Board } from './board/Board'
import { installBrain } from './brain'
import { registerSheetOverlay } from './board/SheetView'
import { MeasureOverlay } from './board/viewAidLayers'
import { InspectOverlay } from './drawing/InspectLayers'
import { useView } from './view'
import { getPlatform } from './platform'
import { fileToOpened } from './platform/browser'
import { formatDuration, formatEta, type ConvertProgress } from './convertProgress'
import { getDocState, openFile, useDocState } from './store'
import brushLogoRed from './ui/assets/brush-logo-red.png'
import { chooseFile, LeftSidebar, RightSidebar, ToolCapsule, TopBar } from './ui/Chrome'
import { RevitHud, RevitStart } from './revit/RevitPanel'
import { isPhotoFile, photoImport, PhotoImportDialog } from './photo/PhotoImport'

installBrain()
registerSheetOverlay(MeasureOverlay) // above the brain overlays
registerSheetOverlay(InspectOverlay) // element highlight (V3), on top

const TldrawSmoke = lazy(() => import('./dev/TldrawSmoke'))

async function openDropped(e: DragEvent) {
  e.preventDefault()
  const f = e.dataTransfer.files?.[0]
  if (!f) return
  // a photo dropped on an open drawing is markup to import (P1-01), not a file to open
  if (isPhotoFile(f) && getDocState().status === 'ready') photoImport.open(f)
  else await openFile(await fileToOpened(f))
}

const formatSize = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`)

/**
 * Sample `.drawing` files from `schema/public/examples` (served by the `sampleDrawings` plugin in vite.config.ts).
 * Picking one fetches it and opens it like a chosen file. Hidden when there are no samples.
 */
function SamplePicker({ disabled }: { disabled: boolean }) {
  const [fetching, setFetching] = useState<string>()
  const [fetchError, setFetchError] = useState<string>()
  if (!samples.length) return null

  async function open(name: string) {
    const sample = samples.find((s) => s.name === name)
    if (!sample) return
    setFetching(sample.name)
    setFetchError(undefined)
    // a file opened while the sample downloads (picker, Ctrl O, drop) bumps loadId; it wins over the late sample
    const loadIdAtStart = getDocState().loadId
    try {
      const res = await fetch(sample.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await res.arrayBuffer()
      setFetching(undefined)
      if (getDocState().loadId !== loadIdAtStart) return
      await openFile({ name: sample.name, size: bytes.byteLength, bytes })
    } catch (e) {
      setFetching(undefined)
      if (getDocState().loadId !== loadIdAtStart) return
      setFetchError(`Could not download the sample “${sample.name}”. (${(e as Error).message})`)
    }
  }

  return (
    <>
      <label className="samples">
        <span className="secondary">{fetching ? `Downloading ${fetching}…` : 'or open a sample'}</span>
        <select data-testid="sample-picker" aria-label="Open a sample drawing" value="" disabled={disabled || !!fetching} onChange={(e) => void open(e.target.value)}>
          <option value="" disabled>
            Choose a sample…
          </option>
          {samples.map((s) => (
            <option key={s.name} value={s.name}>
              {s.label} ({s.name}, {formatSize(s.size)})
            </option>
          ))}
        </select>
      </label>
      {fetchError && (
        <p className="error" role="alert" data-testid="sample-error">
          {fetchError}
        </p>
      )}
    </>
  )
}

/** The bar of a Revit model converting: one `<progress>`, the step in words, time elapsed and time left. */
function ConversionProgress({ name, progress }: { name: string; progress: ConvertProgress }) {
  const percent = progress.fraction === null ? undefined : Math.floor(progress.fraction * 100)
  const times = [progress.etaMs === undefined ? undefined : formatEta(progress.etaMs), `${formatDuration(progress.elapsedMs)} elapsed`].filter(Boolean).join(' · ')
  return (
    <div className="convert-progress" data-testid="convert-progress">
      <progress
        max={1}
        value={progress.fraction ?? undefined}
        aria-label={`Converting ${name}`}
        aria-valuetext={percent === undefined ? progress.label : `${progress.label}, ${percent}%`}
      />
      <p className="convert-step" role="status">
        {progress.label}
        {percent !== undefined && <span className="convert-percent"> · {percent}%</span>}
      </p>
      <p className="convert-times secondary">{times}</p>
    </div>
  )
}

function EmptyState({ error, loading, progress }: { error?: string; loading?: string; progress?: ConvertProgress }) {
  return (
    <div className="empty landing" data-testid="empty-state">
      <div className="landing-paper" aria-hidden="true" />
      <div className="landing-stack">
        <img className="landing-logo" src={brushLogoRed} alt="Brush" />
        <div className="dropzone">
          {/* hand-drawn outline instead of a dashed border; stretched to the box, the stroke keeps its width */}
          <svg className="dropzone-outline" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
            <path
              d="M58 14 C 260 4, 610 20, 942 9 C 978 8, 993 30, 990 62 C 984 150, 997 262, 987 342 C 984 379, 963 393, 926 390 C 648 383, 302 398, 62 387 C 24 386, 9 368, 11 334 C 15 250, 5 138, 13 52 C 16 21, 36 9, 74 12 C 98 13, 118 15, 140 17"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <h1>Drop a PDF to start</h1>
          <div className="cta">
            <button type="button" className="btn landing-cta" title="Choose file (Ctrl+O)" onClick={() => void chooseFile()} disabled={!!loading}>
              {loading ? `Opening ${loading}…` : 'Choose file'}
            </button>
          </div>
          {loading && progress && <ConversionProgress name={loading} progress={progress} />}
          <div className="landing-more">
            <SamplePicker disabled={!!loading} />
            <RevitStart />
          </div>
          {error && (
            <p className="error" role="alert" data-testid="load-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export function App() {
  const st = useDocState()
  const { labelScale } = useView()
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    let unsub: (() => void) | undefined
    void getPlatform().then(async (p) => {
      unsub = await p.onFileDrop((f) => void openFile(f))
    })
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void chooseFile()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unsub?.()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  if (new URLSearchParams(location.search).get('smoke') === 'tldraw') {
    return (
      <Suspense fallback={null}>
        <TldrawSmoke />
      </Suspense>
    )
  }

  const ready = st.status === 'ready'
  return (
    <div
      className={`app${dragOver ? ' drag-over' : ''}${ready ? '' : ' landing-app'}`}
      style={{ '--label-scale': labelScale } as CSSProperties}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false)
        void openDropped(e)
      }}
    >
      <TopBar />
      <div className="body">
        {ready && <LeftSidebar />}
        <main className="canvas-area">
          {ready ? (
            <Board pages={st.pages} loadId={st.loadId} sheets={st.sheets} placements={st.placements} fileName={st.fileName ?? ''} />
          ) : (
            <EmptyState error={st.status === 'error' ? st.error : undefined} loading={st.status === 'loading' ? st.fileName : undefined} progress={st.status === 'loading' ? st.progress : undefined} />
          )}
          {ready && <RevitHud />}
          <ToolCapsule disabled={!ready} />
        </main>
        {ready && <RightSidebar />}
      </div>
      <PhotoImportDialog />
    </div>
  )
}
