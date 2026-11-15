/**
 * Runs explainAway's two heavy loops (./pipeline/fit.ts: fitting the local ink models, then explaining every pixel)
 * on a few helper workers at once, each taking a band of rows. They are the slowest part of reading the ink, run
 * twice per import, and the result is exactly the same as on one thread. Used by the photo worker; if anything goes
 * wrong (no workers inside workers in this browser, a helper that crashes) the loops run on its own thread instead.
 */
import { bandRows, explainRows, fitRows, type Explained, type FitResult, type ModelWorkers } from './pipeline/fit'
import type { ModelReply, ModelRequest } from './model-worker'

type Request = ModelRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never

export function createModelPool(size: number): ModelWorkers {
  let helpers: Worker[] | null = null
  let broken = false
  let nextId = 1

  const call = (worker: Worker, req: Request, transfer: Transferable[]) =>
    new Promise<ModelReply>((resolve, reject) => {
      const id = nextId++
      const done = () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
      }
      const onMessage = (e: MessageEvent<ModelReply>) => {
        if (e.data.id !== id) return
        done()
        if ('error' in e.data) reject(new Error(e.data.error))
        else resolve(e.data)
      }
      const onError = (e: ErrorEvent) => {
        done()
        reject(new Error(e.message || 'model helper failed'))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({ ...req, id }, transfer)
    })

  /** Run `work` on the helpers, or `local` on this thread if they cannot be used. */
  const parallel = async <T>(rows: number, work: (helpers: Worker[]) => Promise<T>, local: () => T): Promise<T> => {
    if (broken || size < 2 || rows < 8 * size) return local()
    try {
      helpers ??= Array.from({ length: size }, () => new Worker(new URL('./model-worker.ts', import.meta.url), { type: 'module' }))
      return await work(helpers)
    } catch {
      broken = true
      for (const h of helpers ?? []) h.terminate()
      helpers = null
      return local()
    }
  }

  /** Split [0, n) into `k` runs. */
  const split = (n: number, k: number) => Array.from({ length: k }, (_, i) => [Math.round((n * i) / k), Math.round((n * (i + 1)) / k)] as const)

  return {
    fit: (grid, rgb, valid, refBlur) =>
      parallel(
        grid.gh,
        async (hs) => {
          const { w, gw, gh } = grid
          const parts = split(gh, hs.length).map(async ([gy0, gy1], k) => {
            const [y0, y1] = bandRows(grid, gy0, gy1)
            const r0 = Math.min(y0, y1)
            const band = { rgb: rgb.slice(r0 * w * 3, y1 * w * 3), valid: valid.slice(r0 * w, y1 * w), refBlur: refBlur.slice(r0 * w * 3, y1 * w * 3), y0: r0 }
            const reply = await call(hs[k], { type: 'fit', grid, band, gy0, gy1 }, [band.rgb.buffer, band.valid.buffer, band.refBlur.buffer])
            return { r: (reply as { fit: FitResult }).fit, gy0 }
          })
          const G = gw * gh
          const out: FitResult = { A: new Float32Array(G * 3), B: new Float32Array(G * 3), ok: new Uint8Array(G), seesPaper: new Uint8Array(G) }
          for (const { r, gy0 } of await Promise.all(parts)) {
            out.A.set(r.A, gy0 * gw * 3)
            out.B.set(r.B, gy0 * gw * 3)
            out.ok.set(r.ok, gy0 * gw)
            out.seesPaper.set(r.seesPaper, gy0 * gw)
          }
          return out
        },
        () => fitRows(grid, { rgb, valid, refBlur, y0: 0 }, 0, grid.gh),
      ),
    explain: (params, rgb, valid, refLo) =>
      parallel(
        params.h,
        async (hs) => {
          const { w, h } = params
          const parts = split(h, hs.length).map(async ([y0, y1], k) => {
            const band = { rgb: rgb.slice(y0 * w * 3, y1 * w * 3), valid: valid.slice(y0 * w, y1 * w), refLo: refLo.slice(y0 * w * 3, y1 * w * 3), y0, y1 }
            const reply = await call(hs[k], { type: 'explain', params, band }, [band.rgb.buffer, band.valid.buffer, band.refLo.buffer])
            return { r: (reply as { explained: Explained }).explained, y0 }
          })
          const N = w * h
          const out: Explained = { absorb: new Uint8Array(N), inkRgb: new Uint8Array(N * 3), clean: new Uint8Array(N * 3), flat: new Uint8Array(N), foreign: new Uint8Array(N), edgeZone: params.edgeNode ? new Uint8Array(N) : null }
          for (const { r, y0 } of await Promise.all(parts)) {
            out.absorb.set(r.absorb, y0 * w)
            out.inkRgb.set(r.inkRgb, y0 * w * 3)
            out.clean.set(r.clean, y0 * w * 3)
            out.flat.set(r.flat, y0 * w)
            out.foreign.set(r.foreign, y0 * w)
            if (out.edgeZone && r.edgeZone) out.edgeZone.set(r.edgeZone, y0 * w)
          }
          return out
        },
        () => explainRows(params, { rgb, valid, refLo, y0: 0, y1: params.h }),
      ),
  }
}
