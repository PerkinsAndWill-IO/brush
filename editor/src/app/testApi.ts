/**
 * window.__brush — the test/agent API (spec "How agents drive the app").
 * Installed only in dev builds or when VITE_TEST=1; see main.tsx.
 *
 * window.__brushDev holds extra dev hooks that are not part of the frozen
 * BrushTestApi contract (autosave flush, recordings, bulk strokes, camera set).
 */
import type { BrushTestApi, Command, DecisionKind, Hypothesis, Stroke, StrokeRecording } from '@core/types'
import { contextFor } from './brain/contextStore'
import { getLive, type LiveState } from './brain/live'
import { acceptReading } from './brain/predictEngine'
import { secondPassMs, setSecondPassRescorer, syntheticCassetteRescorer } from './brain/secondPass'
import { boardView, getViewportEl } from './board/Board'
import { sheetToScreen, type Camera } from './board/layout'
import { getCamera, setCamera } from './camera'
import { metrics, resetMetrics } from './metrics'
import { getRecorder, recorder, isStrokeRecording } from './recording'
import { flushSave, getSession, session, type Tool } from './session'
import { getDocState, openDocument, waitForFirstPage } from './store'
import { configureRevitLink, revit, revitSnapshot } from './revit/controller'
import { importPhotoMarkup, type PhotoImportOptions, type PhotoImportSummary } from './photo/import'

export interface BrushDevApi {
  flushSave(): Promise<void>
  setCamera(c: Camera): void
  fit(): void
  focusSheet(pageIndex: number, maxZ?: number): void
  /** Insert strokes without replaying them (perf fixtures). */
  addStrokes(strokes: Stroke[]): void
  resetMetrics(): void
  recordings(): { fileName: string; json: string; saved: boolean }[]
  isStrokeRecording(v: unknown): boolean
  setRecording(on: boolean, kind?: StrokeRecording['label']['kind']): void
  /** Live reading state of the current/last stroke (phase, chips, snap markers, decision). */
  live(): LiveState
  /** Tap a chip / pick a reading for the pending stroke. */
  accept(kind: DecisionKind): void
  /** Accepted decisions in the session. */
  accepted(): unknown[]
  /**
   * M4: run the second pass on a cassette replayer whose reply has these probabilities, after `latencyMs`
   * (policy overrides like ambiguousBelow / timeoutMs / weight / suggestMin optional). null = off.
   */
  useCassetteRescorer(opts: { probs: Partial<Record<DecisionKind, number>>; latencyMs: number; weight?: number; settings?: Record<string, number> } | null): void
  /** Latencies of answered second-pass calls, ms. */
  secondPassMs(): number[]
  /** Resolves after `n` animation frames. */
  frames(n?: number): Promise<void>
  /** M6: the Revit link as data (state, sheets, open versions, per-command results, hidden strokes). */
  revit(): ReturnType<typeof revitSnapshot>
  /** M6: connect to a link URL (default ws://127.0.0.1:47821/link) with fast retries. */
  revitConnect(url?: string): void
  revitDisconnect(): void
  revitOpenSheet(sheetId: string): void
  revitOpenSheets(sheetIds: string[]): void
  /** M6: send pending commands now instead of after the debounce. */
  revitFlush(): void
  /** P1: trace the markup in a photo (URL or blob) onto its sheet. */
  importPhoto(photo: string | Blob, opts?: Omit<PhotoImportOptions, 'signal'>): Promise<PhotoImportSummary>
  /** P1: a sheet as the document renders it, at `pxPerPt` (used to build test photos). */
  renderSheet(pageIndex: number, pxPerPt: number): Promise<HTMLCanvasElement>
}

declare global {
  interface Window {
    __brush?: BrushTestApi
    __brushDev?: BrushDevApi
  }
}

export function testApiEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_TEST === '1'
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r))
const sleepUntil = (t: number) =>
  new Promise<void>((r) => {
    const d = t - performance.now()
    if (d <= 1) r()
    else setTimeout(r, d)
  })

/**
 * Feed real PointerEvents to the board at the recorded timestamps (or as fast
 * as possible), converting sheet points to screen points via the current camera.
 */
async function replayStroke(rec: StrokeRecording, opts: { realtime?: boolean } = {}) {
  const doc = getDocState()
  const vp = getViewportEl()
  if (doc.status !== 'ready' || !vp) throw new Error('replayStroke: no document open')
  const pl = doc.placements.find((p) => p.pageIndex === rec.sheet)
  if (!pl) throw new Error(`replayStroke: no sheet with pageIndex ${rec.sheet}`)
  if (!rec.points.length) return
  const prevTool = getSession().tool
  const tool: Tool = rec.tool ?? (prevTool === 'eraser' ? 'eraser' : 'brush')
  session.setTool(tool)
  await nextFrame()
  const rect = vp.getBoundingClientRect()
  const hasPressure = rec.points.some((p) => p.p !== undefined)
  const fire = (type: string, p: StrokeRecording['points'][number]) => {
    const s = sheetToScreen(getCamera(), pl, p)
    const down = type !== 'pointerup'
    vp.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 7,
        pointerType: hasPressure ? 'pen' : 'mouse',
        isPrimary: true,
        clientX: rect.left + s.x,
        clientY: rect.top + s.y,
        button: type === 'pointermove' ? -1 : 0,
        buttons: down ? 1 : 0,
        pressure: down ? (p.p ?? 0.5) : 0,
      }),
    )
  }
  const t0 = performance.now()
  const pts = rec.points
  for (let i = 0; i < pts.length; i++) {
    if (opts.realtime) await sleepUntil(t0 + pts[i].t)
    fire(i === 0 ? 'pointerdown' : 'pointermove', pts[i])
  }
  fire('pointerup', pts[pts.length - 1])
  await nextFrame()
  await nextFrame()
  session.setTool(prevTool)
}

export function createTestApi(): BrushTestApi {
  return {
    async loadPdf(url: string) {
      const name = decodeURIComponent(url.split('/').pop() ?? url)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`loadPdf: ${res.status} ${url}`)
      const bytes = await res.arrayBuffer()
      const loadId = await openDocument(bytes, name, { size: bytes.byteLength })
      if (getDocState().sheets.length > 0) await waitForFirstPage(loadId)
    },
    /** Open by URL as the sample picker does (a zstd `.drawing` by range requests when the server has them). */
    async loadUrl(url: string) {
      const loadId = await openDocument(url, decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() ?? url))
      if (getDocState().sheets.length > 0) await waitForFirstPage(loadId)
    },
    sheets: () => getDocState().sheets.map((s) => ({ ...s, sizePt: { ...s.sizePt } })),
    replayStroke,
    strokes: () => structuredClone(getSession().strokes) as Stroke[],
    hypotheses: () => structuredClone(getLive().history) as Hypothesis[],
    commands: () => structuredClone(getSession().commands) as Command[],
    metrics: () => ({
      inkLatencyMs: [...metrics.inkLatencyMs],
      firstHypothesisMs: [...metrics.firstHypothesisMs],
      fps: [...metrics.fps],
    }),
    setSetting(key: string, value: unknown) {
      if (key === 'camera') setCamera(value as Camera, { settleNow: true })
      else session.setSetting(key, value)
    },
    camera: () => ({ ...getCamera() }),
    contextFor: (sheetId: string) => contextFor(sheetId),
    undo: () => session.undo(),
    redo: () => session.redo(),
    setTool: (tool) => session.setTool(tool),
  }
}

function createDevApi(): BrushDevApi {
  return {
    flushSave,
    setCamera: (c) => setCamera(c, { settleNow: true }),
    fit: () => boardView.fit(),
    focusSheet: (i, z) => boardView.focusSheet(i, z),
    addStrokes: (strokes) => session.bulkLoad(strokes),
    resetMetrics,
    recordings: () => getRecorder().items.map((r) => ({ fileName: r.fileName, json: JSON.stringify(r.recording), saved: r.saved })),
    isStrokeRecording,
    setRecording(on, kind) {
      recorder.setEnabled(on)
      if (kind) recorder.setKind(kind)
    },
    live: () => structuredClone(getLive()),
    accept: (k) => acceptReading(k),
    accepted: () => structuredClone(getSession().accepted) as unknown[],
    useCassetteRescorer(opts) {
      if (!opts) return setSecondPassRescorer(null)
      setSecondPassRescorer(syntheticCassetteRescorer({ probs: opts.probs, latencyMs: opts.latencyMs, weight: opts.weight }), opts.settings ?? {})
    },
    secondPassMs,
    async frames(n = 1) {
      for (let i = 0; i < n; i++) await nextFrame()
    },
    revit: () => revitSnapshot(),
    revitConnect(url) {
      configureRevitLink({ url, backoffMs: [200, 400, 800] })
      revit.connect()
    },
    revitDisconnect: () => revit.disconnect(),
    revitOpenSheet: (id) => revit.openSheet(id),
    revitOpenSheets: (ids) => revit.openSheets(ids),
    revitFlush: () => revit.flush(),
    async importPhoto(photo, opts) {
      const blob = typeof photo === 'string' ? await (await fetch(photo)).blob() : photo
      return importPhotoMarkup(blob, opts)
    },
    async renderSheet(pageIndex, pxPerPt) {
      const pages = getDocState().pages
      if (!pages) throw new Error('renderSheet: no document open')
      const canvas = document.createElement('canvas')
      await pages.render(pageIndex, canvas, pxPerPt)
      return canvas
    },
  }
}

export function installTestApi() {
  if (!testApiEnabled()) return
  window.__brush = createTestApi()
  window.__brushDev = createDevApi()
}
