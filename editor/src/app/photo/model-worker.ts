/**
 * Helper of the photo worker: runs one band of explainAway's two heavy loops (./pipeline/fit.ts). Plain JS, no
 * OpenCV, so it starts at once. The photo worker starts a few (./modelPool.ts) and they end with it.
 */
import { explainRows, fitRows, type ExplainBand, type ExplainParams, type Explained, type FitBand, type FitGrid, type FitResult } from './pipeline/fit'

export type ModelRequest =
  | { id: number; type: 'fit'; grid: FitGrid; band: FitBand; gy0: number; gy1: number }
  | { id: number; type: 'explain'; params: ExplainParams; band: ExplainBand }

export type ModelReply =
  | { id: number; fit: FitResult }
  | { id: number; explained: Explained }
  | { id: number; error: string }

const scope = self as unknown as {
  postMessage(message: ModelReply, transfer: Transferable[]): void
  onmessage: ((e: MessageEvent<ModelRequest>) => void) | null
}

const buffers = (arrays: (Uint8Array | Float32Array | null)[]) => arrays.flatMap((a) => (a ? [a.buffer as ArrayBuffer] : []))

scope.onmessage = (e) => {
  const req = e.data
  try {
    if (req.type === 'fit') {
      const r = fitRows(req.grid, req.band, req.gy0, req.gy1)
      scope.postMessage({ id: req.id, fit: r }, buffers([r.A, r.B, r.ok, r.seesPaper]))
    } else {
      const r = explainRows(req.params, req.band)
      scope.postMessage({ id: req.id, explained: r }, buffers([r.absorb, r.inkRgb, r.clean, r.flat, r.foreign, r.edgeZone]))
    }
  } catch (err) {
    scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) }, [])
  }
}
