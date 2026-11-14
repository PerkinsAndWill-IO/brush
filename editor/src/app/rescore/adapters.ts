/**
 * The three M4-01 adapters behind one setting. All optional, all with a hard
 * timeout and abort, none ever awaited by the first pass (see RescoreRunner).
 * Security of the hosted key: docs/decisions/0004-second-pass-adapters.md.
 */
import type { Rescorer } from '@core/types'
import { hostedCodec, jevCodec, localCodec, type RescoreSettings } from '@core/rescore'
import { HttpRescorer, type FetchLike } from './http'

export const ANTHROPIC_VERSION = '2023-06-01'

type S = Pick<RescoreSettings, 'weight' | 'timeoutMs'>

/** Local model: OpenAI-compatible / llama.cpp server, one token, option probabilities from top_logprobs. */
export function localRescorer(s: S & Pick<RescoreSettings, 'localUrl' | 'localModel' | 'localGrammar'>, opts: { apiKey?: string; fetch?: FetchLike } = {}): HttpRescorer {
  return new HttpRescorer({
    codec: localCodec({ model: s.localModel, grammar: s.localGrammar }),
    url: s.localUrl,
    headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
    weight: s.weight,
    timeoutMs: s.timeoutMs,
    fetch: opts.fetch,
  })
}

/**
 * Hosted: Anthropic Messages API over plain fetch, one forced `decide` tool.
 * With `apiKey` the call goes browser -> api.anthropic.com directly (dev only:
 * the key is visible to anyone with the app). Without a key, point
 * `hostedBaseUrl` at a proxy that adds it (production).
 */
export function hostedRescorer(s: S & Pick<RescoreSettings, 'hostedModel' | 'hostedBaseUrl'>, opts: { apiKey?: string; fetch?: FetchLike } = {}): HttpRescorer {
  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_VERSION }
  if (opts.apiKey) {
    headers['x-api-key'] = opts.apiKey
    // Required by the API for CORS requests that carry a key from a browser/WebView.
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  }
  return new HttpRescorer({
    codec: hostedCodec({ model: s.hostedModel }),
    url: `${s.hostedBaseUrl.replace(/\/+$/, '')}/v1/messages`,
    headers,
    weight: s.weight,
    timeoutMs: s.timeoutMs,
    fetch: opts.fetch,
  })
}

/** Jev decision model (ASSUMED contract, see core/rescore/codecs.ts jevCodec). */
export function jevRescorer(s: S & Pick<RescoreSettings, 'jevUrl'>, opts: { apiKey?: string; fetch?: FetchLike } = {}): HttpRescorer {
  return new HttpRescorer({
    codec: jevCodec(),
    url: s.jevUrl,
    headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
    weight: s.weight,
    timeoutMs: s.timeoutMs,
    fetch: opts.fetch,
  })
}

/** The adapter chosen by `settings.adapter`, or null when off. */
export function createRescorer(s: RescoreSettings, opts: { apiKey?: string; fetch?: FetchLike } = {}): Rescorer | null {
  switch (s.adapter) {
    case 'off':
      return null
    case 'local':
      return localRescorer(s, opts)
    case 'hosted':
      return hostedRescorer(s, opts)
    case 'jev':
      return jevRescorer(s, opts)
  }
}
