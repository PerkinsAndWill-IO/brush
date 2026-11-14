/**
 * window.__brush — the test/agent API (spec "How agents drive the app").
 * Installed only in dev builds or when VITE_TEST=1; see main.tsx.
 */
import type { BrushTestApi, Metrics } from '@core/types'
import { getDocState, openDocument, waitForFirstPage } from './store'

declare global {
  interface Window {
    __brush?: BrushTestApi
  }
}

export function testApiEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.VITE_TEST === '1'
}

const metrics: Metrics = { inkLatencyMs: [], firstHypothesisMs: [], fps: [] }

export function createTestApi(): BrushTestApi {
  return {
    async loadPdf(url: string) {
      const name = decodeURIComponent(url.split('/').pop() ?? url)
      const loadId = await openDocument(url, name)
      const sheets = getDocState().sheets
      if (sheets.length > 0) await waitForFirstPage(loadId)
    },
    sheets: () => getDocState().sheets.map((s) => ({ ...s, sizePt: { ...s.sizePt } })),
    async replayStroke() {
      // TODO(M1): feed real pointer events to the canvas at recorded timestamps.
      throw new Error('replayStroke: not implemented until M1')
    },
    strokes: () => [], // TODO(M1)
    hypotheses: () => [], // TODO(M3)
    commands: () => [], // TODO(M5)
    metrics: () => ({
      inkLatencyMs: [...metrics.inkLatencyMs],
      firstHypothesisMs: [...metrics.firstHypothesisMs],
      fps: [...metrics.fps],
    }),
    setSetting() {
      // TODO(M1): route to brush settings store.
    },
    camera: () => ({ x: 0, y: 0, z: 1 }), // TODO(M1): tldraw camera
    async contextFor() {
      return null // TODO(M2)
    },
    undo() {}, // TODO(M1)
    redo() {}, // TODO(M1)
    setTool() {}, // TODO(M1)
  }
}

export function installTestApi() {
  if (!testApiEnabled()) return
  window.__brush = createTestApi()
}
