/**
 * Talks to the conversion server: sends a Revit model, follows the conversion, fetches the `.drawing`.
 *
 * With `Prefer: respond-async` the server answers 202 with `{ id, events, result }` (paths on its own origin):
 * `events` streams `progress` / `done` / `error` as Server-Sent Events and `result` serves the file once done.
 * A server that ignores the header answers 200 with the file itself; then there is no progress to report.
 */
import { ConvertTracker, type ConvertPhase, type ConvertProgress } from './convertProgress'

export interface ConvertRequest {
  url: string
  name: string
  bytes: ArrayBuffer
}

export interface Conversion {
  /** The `.drawing` bytes; rejects with the server's message on failure, and with `ConversionCancelled` after `cancel()`. */
  result: Promise<ArrayBuffer>
  /** Stops everything in flight (requests, event stream, timers). */
  cancel(): void
}

export class ConversionCancelled extends Error {
  constructor() {
    super('Conversion cancelled')
  }
}

const PHASES: ReadonlySet<string> = new Set<ConvertPhase>(['queue', 'parse', 'draw', 'write'])

/** How long after the upload the server may stay silent before it counts as one opaque conversion (an async server answers 202 at once). */
const OPAQUE_AFTER_MS = 2000
/** Event stream errors in a row, with no event between, before giving up (the browser reconnects by itself meanwhile). */
const MAX_STREAM_ERRORS = 4
const TICK_MS = 1000

const isPhase = (p: unknown): p is 'queue' | 'parse' | 'draw' | 'write' => typeof p === 'string' && PHASES.has(p)

const textOf = (buf: ArrayBuffer | null) => (buf ? new TextDecoder().decode(buf).slice(0, 300) : '')

export function startConversion(req: ConvertRequest, onProgress: (p: ConvertProgress) => void): Conversion {
  const tracker = new ConvertTracker(() => performance.now())
  const emit = () => onProgress(tracker.snapshot())
  const ticker = setInterval(emit, TICK_MS)
  let events: EventSource | undefined
  let opaqueTimer: ReturnType<typeof setTimeout> | undefined
  const xhrs = new Set<XMLHttpRequest>()
  let settled = false
  let directAnswer = false
  let rejectAll: (e: Error) => void = () => {}

  const cleanup = () => {
    settled = true
    clearInterval(ticker)
    if (opaqueTimer) clearTimeout(opaqueTimer)
    events?.close()
    xhrs.forEach((x) => x.abort())
    xhrs.clear()
  }

  const result = new Promise<ArrayBuffer>((resolve, reject) => {
    rejectAll = (e) => {
      if (settled) return
      cleanup()
      reject(e)
    }
    const succeed = (bytes: ArrayBuffer) => {
      if (settled) return
      cleanup()
      resolve(bytes)
    }

    /** One XHR with a binary body; `onHeaders` sees the status before the body arrives. */
    const request = (method: 'GET' | 'POST', url: string, opts: { headers?: Record<string, string>; body?: ArrayBuffer; onHeaders?: (status: number) => void; onDownload?: (loaded: number, total: number) => void; onUpload?: (loaded: number, total: number) => void }) =>
      new Promise<{ status: number; body: ArrayBuffer | null }>((res, rej) => {
        const xhr = new XMLHttpRequest()
        xhrs.add(xhr)
        xhr.open(method, url)
        xhr.responseType = 'arraybuffer'
        for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v)
        xhr.upload.onprogress = (e) => opts.onUpload?.(e.loaded, e.lengthComputable ? e.total : 0)
        xhr.onreadystatechange = () => {
          if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED) opts.onHeaders?.(xhr.status)
        }
        xhr.onprogress = (e) => opts.onDownload?.(e.loaded, e.lengthComputable ? e.total : 0)
        xhr.onload = () => {
          xhrs.delete(xhr)
          res({ status: xhr.status, body: xhr.response as ArrayBuffer | null })
        }
        xhr.onerror = () => {
          xhrs.delete(xhr)
          rej(new Error('Network error'))
        }
        xhr.ontimeout = xhr.onerror
        xhr.send(opts.body ?? null)
      })

    const download = async (url: string): Promise<ArrayBuffer> => {
      tracker.update('download')
      emit()
      const r = await request('GET', url, {
        onDownload: (loaded, total) => {
          tracker.update('download', loaded, total)
          emit()
        },
      })
      if (r.status !== 200 || !r.body) throw new Error(`HTTP ${r.status}: ${textOf(r.body)}`)
      return r.body
    }

    const follow = (eventsUrl: string, resultUrl: string) => {
      let errorsInARow = 0
      const es = (events = new EventSource(eventsUrl))
      const parse = (e: MessageEvent): Record<string, unknown> => {
        errorsInARow = 0
        try {
          return JSON.parse(e.data as string) as Record<string, unknown>
        } catch {
          return {}
        }
      }
      es.addEventListener('progress', (e) => {
        const d = parse(e as MessageEvent)
        if (!isPhase(d.phase)) return
        tracker.update(d.phase, Number(d.done) || 0, Number(d.total) || 0)
        emit()
      })
      es.addEventListener('done', () => {
        es.close()
        download(resultUrl).then(succeed, rejectAll)
      })
      // a server's own `error` event carries data; the browser's connection errors do not
      es.addEventListener('error', (e) => {
        const data = (e as MessageEvent).data as string | undefined
        if (typeof data === 'string' && data) {
          const d = parse(e as MessageEvent)
          rejectAll(new Error(`HTTP ${Number(d.status) || 500}: ${typeof d.message === 'string' ? d.message : 'the conversion failed'}`))
          return
        }
        errorsInARow++
        if (es.readyState === EventSource.CLOSED || errorsInARow >= MAX_STREAM_ERRORS) rejectAll(new Error('Lost the connection to the conversion server'))
      })
    }

    tracker.update('upload', 0, req.bytes.byteLength)
    emit()
    opaqueTimer = undefined
    request('POST', req.url, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(req.name), Prefer: 'respond-async' },
      body: req.bytes,
      onUpload: (loaded, total) => {
        tracker.update('upload', loaded, total || req.bytes.byteLength)
        emit()
        if (total > 0 && loaded >= total) {
          // the model is up: an async server answers at once, one that converts before answering keeps us waiting
          tracker.update('queue')
          emit()
          opaqueTimer = setTimeout(() => {
            tracker.setOpaque()
            tracker.update('convert')
            emit()
          }, OPAQUE_AFTER_MS)
        }
      },
      onHeaders: (status) => {
        if (opaqueTimer) clearTimeout(opaqueTimer)
        if (status === 200) {
          // the server answers with the file itself: no conversion progress, only the download
          directAnswer = true
          tracker.setOpaque()
          tracker.update('download')
          emit()
        }
      },
      onDownload: (loaded, total) => {
        // only the 200 answer streams a body worth following; a 202 body is a few bytes of JSON
        if (!directAnswer) return
        tracker.update('download', loaded, total)
        emit()
      },
    }).then((r) => {
      if (settled) return
      if (r.status === 200 && r.body) return succeed(r.body)
      if (r.status === 202) {
        let info: { events?: unknown; result?: unknown }
        try {
          info = JSON.parse(new TextDecoder().decode(r.body ?? new ArrayBuffer(0)))
        } catch {
          throw new Error('HTTP 202: the server did not say where to follow the conversion')
        }
        if (typeof info.events !== 'string' || typeof info.result !== 'string') throw new Error('HTTP 202: the server did not say where to follow the conversion')
        tracker.update('queue')
        emit()
        return follow(new URL(info.events, req.url).toString(), new URL(info.result, req.url).toString())
      }
      throw new Error(`HTTP ${r.status}: ${textOf(r.body)}`)
    }, rejectAll).catch((e: unknown) => rejectAll(e instanceof Error ? e : new Error(String(e))))
  })

  return {
    result,
    cancel: () => rejectAll(new ConversionCancelled()),
  }
}
