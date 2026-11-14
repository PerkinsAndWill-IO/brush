/**
 * App shell: top bar, sidebars, the board (or the empty state) and the tool
 * capsule. Layout and look follow docs/design/project/{Main,Empty}.dc.html.
 */
import { lazy, Suspense, useEffect, useState, type CSSProperties, type DragEvent } from 'react'
import { Board } from './board/Board'
import { installBrain } from './brain'
import { registerSheetOverlay } from './board/SheetView'
import { MeasureOverlay } from './board/viewAidLayers'
import { useView } from './view'
import { getPlatform } from './platform'
import { fileToOpened } from './platform/browser'
import { openFile, useDocState } from './store'
import { EmptyIllustration } from './ui/icons'
import { chooseFile, LeftSidebar, RightSidebar, ToolCapsule, TopBar } from './ui/Chrome'

installBrain()
registerSheetOverlay(MeasureOverlay) // above the brain overlays

const TldrawSmoke = lazy(() => import('./dev/TldrawSmoke'))

async function openDropped(e: DragEvent) {
  e.preventDefault()
  const f = e.dataTransfer.files?.[0]
  if (f) await openFile(await fileToOpened(f))
}

function EmptyState({ error, loading }: { error?: string; loading?: string }) {
  return (
    <div className="empty" data-testid="empty-state">
      <div className="dropzone">
        <EmptyIllustration />
        <div className="copy">
          <h1>
            Drop a <span className="mono">PDF</span> to start
          </h1>
          <p>
            Each page opens here as a sheet, side by side, ready to sketch on. Exported <span className="mono">.drawing</span> packages arrive later.
          </p>
        </div>
        <div className="cta">
          <button type="button" className="btn accent" onClick={() => void chooseFile()} disabled={!!loading}>
            {loading ? `Opening ${loading}…` : 'Choose file'}
          </button>
          <span className="secondary">
            or press <kbd>Ctrl O</kbd>
          </span>
        </div>
        {error && (
          <p className="error" role="alert" data-testid="load-error">
            {error}
          </p>
        )}
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
      className={`app${dragOver ? ' drag-over' : ''}`}
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
            <Board doc={st.doc} loadId={st.loadId} sheets={st.sheets} placements={st.placements} fileName={st.fileName ?? ''} />
          ) : (
            <EmptyState error={st.status === 'error' ? st.error : undefined} loading={st.status === 'loading' ? st.fileName : undefined} />
          )}
          <ToolCapsule disabled={!ready} />
        </main>
        {ready && <RightSidebar />}
      </div>
    </div>
  )
}
