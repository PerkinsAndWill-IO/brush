/**
 * Page render queue: at most CONCURRENCY pdf.js renders at a time, highest
 * priority first (visible sheets, then page order). A new request for the same
 * key replaces a queued one and aborts a running one.
 */
const CONCURRENCY = 2

interface Job {
  key: string
  priority: number
  run: (signal: AbortSignal) => Promise<void>
  ac: AbortController
  resolve: () => void
  reject: (e: unknown) => void
}

const queue: Job[] = []
const running = new Map<string, Job>()

function pump() {
  while (running.size < CONCURRENCY && queue.length) {
    queue.sort((a, b) => a.priority - b.priority)
    const job = queue.shift()!
    running.set(job.key, job)
    job
      .run(job.ac.signal)
      .then(job.resolve, job.reject)
      .finally(() => {
        if (running.get(job.key) === job) running.delete(job.key)
        pump()
        checkIdle()
      })
  }
}

/** Lower priority number runs first. */
export function enqueueRender(key: string, priority: number, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  cancelRender(key)
  return new Promise<void>((resolve, reject) => {
    queue.push({ key, priority, run, ac: new AbortController(), resolve, reject })
    pump()
  })
}

export function cancelRender(key: string) {
  const qi = queue.findIndex((j) => j.key === key)
  if (qi >= 0) {
    const [j] = queue.splice(qi, 1)
    j.reject(new DOMException('aborted', 'AbortError'))
  }
  const r = running.get(key)
  if (r) {
    r.ac.abort()
    running.delete(key)
  }
  checkIdle()
}

const idleWaiters = new Set<() => void>()
function checkIdle() {
  if (queue.length || running.size) return
  idleWaiters.forEach((w) => w())
  idleWaiters.clear()
}

/**
 * Resolves once no page render is queued or running (or after `maxMs`). Renders are queued a frame or two after the
 * camera moves, so callers that just moved it should wait a couple of frames first.
 */
export function whenRendersIdle(maxMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      idleWaiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, maxMs)
    idleWaiters.add(done)
    checkIdle()
  })
}
