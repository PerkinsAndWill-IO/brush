/**
 * P1: the photo worker's helper pool (src/app/photo/modelPool.ts) falls back to its own thread when a helper fails,
 * and steps running at the same time on the other helpers fall back with it instead of waiting forever.
 */
import { describe, expect, it } from 'vitest'
import { createModelPool, type HelperWorker } from '../../../src/app/photo/modelPool'
import type { ModelRequest } from '../../../src/app/photo/model-worker'
import { lanczosReduceRows } from '../../../src/app/photo/pipeline/raster'

/** A helper that never answers, except that the one marked `failing` reports an error for its first request. */
function fakeHelpers(failing: number) {
  const made: { terminated: boolean }[] = []
  const make = (): HelperWorker => {
    const index = made.length
    const state = { terminated: false }
    made.push(state)
    const listeners = new Set<EventListener>()
    let first = true
    return {
      addEventListener: (type: string, l: EventListenerOrEventListenerObject) => void (type === 'message' && listeners.add(l as EventListener)),
      removeEventListener: (type: string, l: EventListenerOrEventListenerObject) => void listeners.delete(l as EventListener),
      postMessage: (msg: ModelRequest) => {
        if (index !== failing || !first) return
        first = false
        setTimeout(() => listeners.forEach((l) => l(new MessageEvent('message', { data: { id: msg.id, error: 'out of memory' } }))), 5)
      },
      terminate: () => void (state.terminated = true),
    } as HelperWorker
  }
  return { make, made }
}

describe('photo pipeline: helper pool', () => {
  it('P1: when a helper fails, every step in flight falls back to this thread and gives the same result', async () => {
    const { make, made } = fakeHelpers(1)
    const pool = createModelPool(3, make)
    const w = 300, h = 240
    const grey = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) % 251)
    const rgb = Uint8Array.from({ length: w * h * 3 }, (_, i) => (i * 13) % 253)
    // the grey and colour shrinks at once, as the registration runs them
    const [a, b] = await Promise.all([pool.shrink(grey, w, h, 1, 200, 160), pool.shrink(rgb, w, h, 3, 200, 160)])
    expect(Array.from(a)).toEqual(Array.from(lanczosReduceRows(grey, 0, w, h, 1, 200, 160, 0, 160)))
    expect(Array.from(b)).toEqual(Array.from(lanczosReduceRows(rgb, 0, w, h, 3, 200, 160, 0, 160)))
    expect(made.every((m) => m.terminated)).toBe(true)
    // and the pool keeps working on this thread
    const c = await pool.shrink(grey, w, h, 1, 100, 80)
    expect(Array.from(c)).toEqual(Array.from(lanczosReduceRows(grey, 0, w, h, 1, 100, 80, 0, 80)))
  })
})
