/**
 * Async API for sheet context. Builds happen in a Web Worker (extract + infer), results are cached per sheet.
 *
 *   const ctx = createContextClient()
 *   await ctx.open(bytesOrUrl)             // once per loaded PDF (bytes are copied, yours stay usable)
 *   const sc = await ctx.getContext('sheet-0')   // SheetContext, cached; concurrent calls share one build
 *   ctx.buildMs('sheet-0')                 // worker build time, for perf marks
 *   ctx.close()
 */
import type { SheetContext } from '@core/types'
import type { ContextRequest, ContextResponse } from './protocol'

export interface ContextClient {
  /** Open (or replace) the document. Clears the cache. */
  open(source: string | ArrayBuffer | Uint8Array): Promise<void>
  /** Context for `sheet-<pageIndex>`; cached per sheet. Rejects if the build failed. */
  getContext(sheetId: string): Promise<SheetContext>
  /** Worker build time of a finished sheet, ms. */
  buildMs(sheetId: string): number | undefined
  close(): void
}

export interface ContextClientOptions {
  /** Defaults to the bundled module worker. */
  workerFactory?: () => Worker
}

type ContextReply = { context: SheetContext; buildMs: number }

export function createContextClient(opts: ContextClientOptions = {}): ContextClient {
  let worker: Worker | null = null
  let nextId = 1
  const pending = new Map<number, { resolve: (r: ContextResponse) => void; reject: (e: Error) => void }>()
  let cache = new Map<string, Promise<SheetContext>>()
  let times = new Map<string, number>()
  let generation = 0

  const ensure = (): Worker => {
    if (worker) return worker
    const w = opts.workerFactory ? opts.workerFactory() : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<ContextResponse>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.ok) p.resolve(e.data)
      else p.reject(new Error(e.data.error))
    }
    w.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'context worker crashed'))
      pending.clear()
    }
    worker = w
    return w
  }

  const call = (req: DistributiveOmit<ContextRequest, 'id'>, transfer: Transferable[] = []): Promise<ContextResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ensure().postMessage({ ...req, id }, transfer)
    })

  return {
    async open(source) {
      generation++
      cache = new Map()
      times = new Map()
      if (typeof source === 'string') {
        await call({ type: 'open', source })
        return
      }
      const copy = source instanceof Uint8Array ? source.slice() : new Uint8Array(source.slice(0))
      await call({ type: 'open', source: copy }, [copy.buffer])
    },
    getContext(sheetId) {
      const hit = cache.get(sheetId)
      if (hit) return hit
      const gen = generation
      const p = call({ type: 'context', sheetId }).then((r) => {
        const res = r as unknown as ContextReply
        if (gen === generation) times.set(sheetId, res.buildMs)
        return res.context
      })
      cache.set(sheetId, p)
      // do not cache failures
      p.catch(() => {
        if (cache.get(sheetId) === p) cache.delete(sheetId)
      })
      return p
    },
    buildMs: (sheetId) => times.get(sheetId),
    close() {
      worker?.terminate()
      worker = null
      for (const p of pending.values()) p.reject(new Error('context client closed'))
      pending.clear()
      cache = new Map()
      times = new Map()
    },
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
