/**
 * M0 skeleton. Empty state + a plain DOM list of rendered sheets so the
 * harness can load a fixture and screenshot it. The canvas lane replaces
 * SheetList with the tldraw board in M1.
 */
import { lazy, Suspense, useEffect, useRef, useState, type DragEvent } from 'react'
import type { Sheet } from '@core/types'
import { renderPage } from './pdf/pdfjs'
import { getPlatform, type OpenedFile } from './platform'
import { fileToOpened } from './platform/browser'
import { notifyPageRendered, openDocument, useDocState } from './store'

const TldrawSmoke = lazy(() => import('./dev/TldrawSmoke'))

async function openFile(file: OpenedFile) {
  await openDocument(file.bytes, file.name).catch(() => {})
}

function EmptyState({ error }: { error?: string }) {
  const [over, setOver] = useState(false)
  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const f = e.dataTransfer.files?.[0]
    if (f) await openFile(await fileToOpened(f))
  }
  return (
    <div
      className={`empty${over ? ' over' : ''}`}
      data-testid="empty-state"
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="dropzone">
        <p className="title">Drop a PDF to start sketching</p>
        <p className="sub">Each page becomes a sheet on the board.</p>
        <button
          type="button"
          onClick={async () => {
            const f = await (await getPlatform()).openPdf()
            if (f) await openFile(f)
          }}
        >
          Choose file
        </button>
        {error && (
          <p className="error" role="alert" data-testid="load-error">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

function SheetView({ sheet, loadId }: { sheet: Sheet; loadId: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { doc } = useDocState()
  const [rendered, setRendered] = useState(false)
  useEffect(() => {
    if (!doc || !ref.current) return
    const ac = new AbortController()
    const scale = Math.min(1, 900 / sheet.sizePt.w)
    renderPage(doc, sheet.pageIndex, ref.current, scale, ac.signal)
      .then(() => {
        if (ac.signal.aborted) return
        setRendered(true)
        notifyPageRendered(loadId, sheet.pageIndex)
      })
      .catch((e) => {
        if (!ac.signal.aborted) console.error('render failed', e)
      })
    return () => ac.abort()
  }, [doc, sheet, loadId])
  return (
    <figure className="sheet" data-testid="sheet" data-sheet-id={sheet.id} data-rendered={rendered}>
      <figcaption>{sheet.name}</figcaption>
      <canvas ref={ref} />
    </figure>
  )
}

export function App() {
  const st = useDocState()

  useEffect(() => {
    let unsub: (() => void) | undefined
    void getPlatform().then(async (p) => {
      unsub = await p.onFileDrop((f) => void openFile(f))
    })
    return () => unsub?.()
  }, [])

  if (new URLSearchParams(location.search).get('smoke') === 'tldraw') {
    return (
      <Suspense fallback={null}>
        <TldrawSmoke />
      </Suspense>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <strong>Brush</strong>
        <span className="muted">{st.status === 'ready' ? `${st.fileName} · ${st.sheets.length} sheets` : 'No file'}</span>
      </header>
      {st.status === 'ready' ? (
        <main className="board" data-testid="board">
          {st.sheets.map((s) => (
            <SheetView key={`${st.loadId}:${s.id}`} sheet={s} loadId={st.loadId} />
          ))}
        </main>
      ) : st.status === 'loading' ? (
        <main className="board" data-testid="loading">
          Loading {st.fileName}…
        </main>
      ) : (
        <EmptyState error={st.error} />
      )}
    </div>
  )
}
