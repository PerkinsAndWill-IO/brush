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
import { SelectionOverlay, TypeMenu } from './select/SelectLayers'
import { useView } from './view'
import { getPlatform } from './platform'
import { fileToOpened } from './platform/browser'
import { formatDuration, formatEta, type ConvertProgress } from './convertProgress'
import { getDocState, openDocument, openFile, useDocState } from './store'
import brushLogoRed from './ui/assets/brush-logo-red.png'
import { BrushLoader } from './ui/BrushLoader'
import { chooseFile, LeftSidebar, RightSidebar, ToolCapsule, TopBar } from './ui/Chrome'
import { HandLoader } from './ui/HandLoader'
import sampleSmallIcon from './ui/assets/sample-small.png'
import sampleMediumIcon from './ui/assets/sample-medium.png'
import sampleLargeIcon from './ui/assets/sample-large.png'
import { RevitHud, RevitStart, RoundTripTimer } from './revit/RevitPanel'
import { useRevit } from './revit/controller'
import { isPhotoFile, photoImport, PhotoImportDialog } from './photo/PhotoImport'
import { TraceControl } from './photo/TracePaper'

installBrain()
registerSheetOverlay(MeasureOverlay) // above the brain overlays
registerSheetOverlay(SelectionOverlay) // selection and type changes (S1)
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

/** Sample cards are named by how big the drawing is, each with a hand-drawn building of that size. */
const SAMPLE_TIERS = [
  { below: 1e6, name: 'Small', icon: sampleSmallIcon },
  { below: 50e6, name: 'Medium', icon: sampleMediumIcon },
  { below: Infinity, name: 'Large', icon: sampleLargeIcon },
]
const sampleTier = (size: number) => SAMPLE_TIERS.find((t) => size < t.below)!

/**
 * Sample `.drawing` files: those in `schema/public/examples` (served by the `sampleDrawings` plugin in vite.config.ts)
 * and remote ones. Picking one opens it by URL (a zstd file on a server with range requests opens from its first
 * sheet). Hidden when there are no samples.
 */
function SamplePicker({ disabled, loading, bytes }: { disabled: boolean; loading?: string; bytes?: number }) {
  if (!samples.length) return null

  function open(name: string) {
    const sample = samples.find((s) => s.name === name)
    // a failure is shown inline by the start page (load-error)
    if (sample) void openDocument(sample.url, sample.name, { size: sample.size }).catch(() => {})
  }

  return (
    <>
      <div className="samples" role="group" aria-labelledby="samples-heading" data-testid="sample-picker">
        <span className="secondary" id="samples-heading">
          or open a sample
        </span>
        <div className="sample-cards">
          {samples.map((s) => {
            const tier = sampleTier(s.size)
            const busy = loading === s.name
            return (
              <button
                key={s.name}
                type="button"
                className="sample-card"
                data-sample={s.name}
                title={`${s.label} (${s.name})`}
                aria-label={`${tier.name} sample: ${s.label}, ${formatSize(s.size)}`}
                aria-busy={busy}
                disabled={disabled}
                onClick={() => open(s.name)}
              >
                <span className="sample-art" aria-hidden="true">
                  {busy ? <HandLoader size={30} /> : <img className="sample-icon" src={tier.icon} alt="" />}
                </span>
                <span className="sample-text">
                  <span className="sample-name">{tier.name}</span>
                  <span className="sample-meta">{busy ? (bytes ? formatSize(bytes) : 'Opening…') : formatSize(s.size)}</span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
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

/** Hand-drawn outline instead of a dashed border; stretched to the box, the stroke keeps its width. */
function DropOutline() {
  return (
    <svg className="dropzone-outline" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M58 14 C 260 4, 610 20, 942 9 C 978 8, 993 30, 990 62 C 984 150, 997 262, 987 342 C 984 379, 963 393, 926 390 C 648 383, 302 398, 62 387 C 24 386, 9 368, 11 334 C 15 250, 5 138, 13 52 C 16 21, 36 9, 74 12 C 98 13, 118 15, 140 17"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/**
 * Linked to Revit: the drop card becomes the sheet picker. Logo and file button shrink to one header row, the card
 * takes the window's height, and only the sheet list scrolls (its footer with the open button stays in view).
 */
function PickerState({ error }: { error?: string }) {
  return (
    <div className="empty landing picking" data-testid="empty-state">
      <div className="landing-paper" aria-hidden="true" />
      <div className="landing-stack picking">
        <div className="dropzone picker-card" data-testid="revit-picker-card">
          <DropOutline />
          <div className="picker-head">
            <img className="picker-logo" src={brushLogoRed} alt="Brush" />
            <span className="picker-hint">
              or drop a PDF, <span className="ext">.rvt</span> or <span className="ext">.drawing</span> anywhere
            </span>
            <button type="button" className="btn picker-file" title="Choose file (Ctrl+O)" onClick={() => void chooseFile()}>
              Choose file
            </button>
          </div>
          <RevitStart />
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

function EmptyState({ error, loading, bytes, progress }: { error?: string; loading?: string; bytes?: number; progress?: ConvertProgress }) {
  const linked = useRevit().link.state === 'on'
  if (linked && !loading) return <PickerState error={error} />
  return (
    <div className="empty landing" data-testid="empty-state">
      <div className="landing-paper" aria-hidden="true" />
      <div className="landing-stack">
        {loading ? (
          <BrushLoader tone="red" className="landing-logo" label={`Opening ${loading}`} />
        ) : (
          <img className="landing-logo" src={brushLogoRed} alt="Brush" />
        )}
        <div className="dropzone">
          <DropOutline />
          <h1>
            Drop a PDF, <span className="ext">.rvt</span> or <span className="ext">.drawing</span> to start
          </h1>
          <div className="cta">
            {loading ? (
              <div className="landing-loading" role="status" data-testid="landing-loading">
                <HandLoader />
                <span>
                  Opening {loading}…{bytes ? ` ${formatSize(bytes)}` : ''}
                </span>
              </div>
            ) : (
              <button type="button" className="btn landing-cta" title="Choose file (Ctrl+O)" onClick={() => void chooseFile()}>
                Choose file
              </button>
            )}
          </div>
          {loading && progress && <ConversionProgress name={loading} progress={progress} />}
          <div className="landing-more">
            <SamplePicker disabled={!!loading} loading={loading} bytes={bytes} />
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
            <EmptyState
              error={st.status === 'error' ? st.error : undefined}
              loading={st.status === 'loading' ? st.fileName : undefined}
              bytes={st.openedBytes}
              progress={st.status === 'loading' ? st.progress : undefined}
            />
          )}
          {ready && <RevitHud />}
          {ready && <RoundTripTimer />}
          {ready && <TraceControl />}
          <ToolCapsule disabled={!ready} />
        </main>
        {ready && <RightSidebar />}
      </div>
      <PhotoImportDialog />
      <TypeMenu />
    </div>
  )
}
