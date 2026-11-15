/**
 * Helper of the photo worker: runs one band of explainAway's two heavy loops (./pipeline/fit.ts), of a Lanczos
 * reduction or of the photo's warp into sheet space. Plain JS, no
 * OpenCV, so it starts at once. The photo worker starts a few (./modelPool.ts) and they end with it.
 */
import { explainRows, fitRows, type ExplainBand, type ExplainParams, type Explained, type FitBand, type FitGrid, type FitResult } from './pipeline/fit'
import { lanczosReduceRows, type Mat3, type RgbImage } from './pipeline/raster'
import { warpRgbRows, type Field, type Warp } from './pipeline/warp'

export type ModelRequest =
  | { id: number; type: 'fit'; grid: FitGrid; band: FitBand; gy0: number; gy1: number }
  | { id: number; type: 'explain'; params: ExplainParams; band: ExplainBand }
  /** Output rows [oy0, oy1) of a reduction from `h` to `nh` rows; `band` holds source rows bandY0.. */
  | { id: number; type: 'shrink'; band: Uint8Array; bandY0: number; w: number; h: number; ch: number; nw: number; nh: number; oy0: number; oy1: number }
  /** Keep this photo for the warps that follow (sent once per photo). */
  | { id: number; type: 'photo'; key: number; photo: RgbImage }
  /** Rows [r0, r1) of the warp of photo `key` into sheet space. */
  | { id: number; type: 'warp'; key: number; toPhoto: Mat3; field: Field | null; fieldScale: number; w: number; r0: number; r1: number }

export type ModelReply =
  | { id: number; fit: FitResult }
  | { id: number; explained: Explained }
  | { id: number; shrunk: Uint8Array }
  | { id: number; warped: Warp }
  | { id: number; kept: true }
  | { id: number; error: string }

const scope = self as unknown as {
  postMessage(message: ModelReply, transfer: Transferable[]): void
  onmessage: ((e: MessageEvent<ModelRequest>) => void) | null
}

const buffers = (arrays: (Uint8Array | Float32Array | null)[]) => arrays.flatMap((a) => (a ? [a.buffer as ArrayBuffer] : []))

let photo: { key: number; photo: RgbImage } | null = null

scope.onmessage = (e) => {
  const req = e.data
  try {
    if (req.type === 'fit') {
      const r = fitRows(req.grid, req.band, req.gy0, req.gy1)
      scope.postMessage({ id: req.id, fit: r }, buffers([r.A, r.B, r.ok, r.seesPaper]))
    } else if (req.type === 'explain') {
      const r = explainRows(req.params, req.band)
      scope.postMessage({ id: req.id, explained: r }, buffers([r.absorb, r.inkRgb, r.clean, r.flat, r.foreign, r.edgeZone]))
    } else if (req.type === 'shrink') {
      const r = lanczosReduceRows(req.band, req.bandY0, req.w, req.h, req.ch, req.nw, req.nh, req.oy0, req.oy1)
      scope.postMessage({ id: req.id, shrunk: r }, buffers([r]))
    } else if (req.type === 'photo') {
      photo = { key: req.key, photo: req.photo }
      scope.postMessage({ id: req.id, kept: true }, [])
    } else {
      if (photo?.key !== req.key) throw new Error('photo not sent')
      const r = warpRgbRows(photo.photo, req.toPhoto, req.field, req.fieldScale, req.w, req.r0, req.r1)
      scope.postMessage({ id: req.id, warped: r }, buffers([r.rgb, r.valid]))
    }
  } catch (err) {
    scope.postMessage({ id: req.id, error: err instanceof Error ? err.message : String(err) }, [])
  }
}
