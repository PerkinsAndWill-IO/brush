import type { ContextPacket, Hypothesis, Rescorer } from '@core/types'
import { finishRescore, type RescoreCodec } from '@core/rescore'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export class RescoreTimeoutError extends Error {
  constructor(ms: number) {
    super(`second pass timed out after ${ms} ms`)
    this.name = 'RescoreTimeoutError'
  }
}

export class RescoreHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`second pass HTTP ${status}: ${detail.slice(0, 200)}`)
    this.name = 'RescoreHttpError'
  }
}

/**
 * POST JSON with a hard timeout and an optional caller signal. Rejects with
 * RescoreTimeoutError / RescoreHttpError / AbortError; never hangs past timeoutMs.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, timeoutMs)
  const onAbort = () => ctrl.abort()
  if (signal?.aborted) ctrl.abort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  // Race the fetch against the abort so a fetch that ignores its signal still cannot hold the caller.
  const aborted = new Promise<never>((_, reject) =>
    ctrl.signal.addEventListener('abort', () => reject(timedOut ? new RescoreTimeoutError(timeoutMs) : new DOMException('second pass aborted', 'AbortError')), {
      once: true,
    }),
  )
  aborted.catch(() => {}) // handled by the race below
  try {
    if (ctrl.signal.aborted) return await aborted
    const res = await Promise.race([fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal }), aborted])
    if (!res.ok) throw new RescoreHttpError(res.status, await Promise.race([res.text(), aborted]))
    return await Promise.race([res.json(), aborted])
  } catch (e) {
    if (timedOut) throw new RescoreTimeoutError(timeoutMs)
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export interface HttpRescorerOptions {
  codec: RescoreCodec
  url: string
  headers?: Record<string, string>
  /** Fusion weight (RescoreSettings.weight). */
  weight: number
  timeoutMs: number
  fetch?: FetchLike
}

/** One HTTP adapter = a codec + an endpoint. Implements the frozen Rescorer (plus an optional AbortSignal). */
export class HttpRescorer implements Rescorer {
  readonly name: string
  constructor(readonly opts: HttpRescorerOptions) {
    this.name = `${opts.codec.adapter}:${opts.codec.model}`
  }

  private get fetchImpl(): FetchLike {
    return this.opts.fetch ?? (globalThis.fetch.bind(globalThis) as unknown as FetchLike)
  }

  /** Raw call, used by the cassette recorder: body sent, reply received, latency. */
  async call(packet: ContextPacket, signal?: AbortSignal): Promise<{ body: Record<string, unknown>; raw: unknown; latencyMs: number }> {
    const body = this.opts.codec.buildRequest(packet)
    const t0 = performance.now()
    const raw = await postJson(this.fetchImpl, this.opts.url, body, this.opts.headers ?? {}, this.opts.timeoutMs, signal)
    return { body, raw, latencyMs: performance.now() - t0 }
  }

  async rescore(packet: ContextPacket, candidates: Hypothesis[], signal?: AbortSignal): Promise<Hypothesis[]> {
    const { raw } = await this.call(packet, signal)
    return finishRescore(this.opts.codec, raw, packet, candidates, this.opts.weight)
  }
}
