/**
 * App shell: top bar, sidebars, the board (or the empty state) and the tool
 * capsule. Layout and look follow docs/design/project/{Main,Empty}.dc.html.
 */
import { lazy, Suspense, useEffect, useState, type DragEvent } from 'react'
import samples from 'virtual:brush-samples'
import { Board } from './board/Board'
import { installBrain } from './brain'
import { getPlatform } from './platform'
import { fileToOpened } from './platform/browser'
import { openFile, useDocState } from './store'
import { EmptyIllustration } from './ui/icons'
import { chooseFile, LeftSidebar, RightSidebar, ToolCapsule, TopBar } from './ui/Chrome'

installBrain()

const TldrawSmoke = lazy(() => import('./dev/TldrawSmoke'))

async function openDropped(e: DragEvent) {
  e.preventDefault()
  const f = e.dataTransfer.files?.[0]
  if (f) await openFile(await fileToOpened(f))
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
    try {
      const res = await fetch(sample.url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = await res.arrayBuffer()
      setFetching(undefined)
      await openFile({ name: sample.name, size: bytes.byteLength, bytes })
    } catch (e) {
      setFetching(undefined)
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
            Each page opens here as a sheet, side by side, ready to sketch on. Exported <span className="mono">.drawing</span> packages open too.
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
        <SamplePicker disabled={!!loading} />
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
            <EmptyState error={st.status === 'error' ? st.error : undefined} loading={st.status === 'loading' ? st.fileName : undefined} />
          )}
          <ToolCapsule disabled={!ready} />
        </main>
        {ready && <RightSidebar />}
      </div>
    </div>
  )
}
