/**
 * M4 second pass in the app (docs/decisions/0004). A RescoreRunner off the
 * critical path: the engine calls `considerSecondPass()` at pen-up and never
 * waits; answers arrive in `onResult` and go through rule 6 (`resolveAnswer`):
 * apply before commit, a suggestion chip after commit, or drop.
 *
 * The adapter (Off / Local / Hosted / Jev) is a setting (left sidebar), default
 * from Vite env (`VITE_BRUSH_RESCORER`, else off). The hosted key never reaches
 * the bundle: the dev proxy (or your production proxy) adds it.
 */
import { useSyncExternalStore } from 'react'
import type { ContextPacket, Hypothesis, Rescorer } from '@core/types'
import {
  CASSETTE_SCHEMA,
  CassetteRescorer,
  RescoreRunner,
  codecFor,
  normalizeProbs,
  requestHash,
  syntheticResponse,
  type AdapterId,
  type Cassette,
  type RescoreAdapterSetting,
  type RescoreRequest,
  type RescoreResult,
  type RescoreSettings,
} from '@core/rescore'
import { createSecondPass, rescoreSettingsFromEnv } from '../rescore'

type Handler = (r: RescoreResult, settings: RescoreSettings) => void

interface State {
  adapter: RescoreAdapterSetting
  /** Name of the rescorer in use ('cassette:hosted' in tests). */
  name: string | null
}

const env = rescoreSettingsFromEnv()
let settings: RescoreSettings = { ...env.settings }
let runner: RescoreRunner | null = null
let handler: Handler = () => {}
let state: State = { adapter: settings.adapter, name: null }
const listeners = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

const onResult = (r: RescoreResult) => handler(r, settings)

/** The engine registers what to do with answers (rule 6 lives there, with the live state). */
export function onSecondPassResult(h: Handler) {
  handler = h
}

/** Off / Local / Hosted / Jev, from the settings UI. */
export function setSecondPassAdapter(adapter: RescoreAdapterSetting) {
  runner?.cancel()
  settings = { ...settings, adapter }
  const made = createSecondPass(settings, { apiKey: env.apiKey, onResult })
  runner = made?.runner ?? null
  emit({ adapter, name: adapter === 'off' ? null : adapter })
}

/** Dev/tests: run a given rescorer (e.g. a cassette replayer) with optional policy overrides. */
export function setSecondPassRescorer(rescorer: Rescorer | null, overrides: Partial<RescoreSettings> = {}) {
  runner?.cancel()
  if (!rescorer) return setSecondPassAdapter('off')
  settings = { ...settings, ...overrides, adapter: overrides.adapter ?? (settings.adapter === 'off' ? 'hosted' : settings.adapter) }
  runner = new RescoreRunner({ rescorer, settings, now: () => performance.now(), onResult })
  emit({ adapter: settings.adapter, name: rescorer.name })
}

/** Fire-and-forget; returns whether a call started (policy: only ambiguous readings). */
export function considerSecondPass(req: RescoreRequest): boolean {
  return runner?.consider(req) ?? false
}

export const secondPassMs = (): number[] => [...(runner?.secondPassMs ?? [])]
export const secondPassSettings = () => settings
export const useSecondPass = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )

if (settings.adapter !== 'off') setSecondPassAdapter(settings.adapter)

/**
 * A CassetteRescorer whose cassette is synthesised for each packet with fixed
 * probabilities (the replay path is the real one: request hash, the adapter's
 * reply parser, fusion, simulated latency). For tests and demos only.
 */
export function syntheticCassetteRescorer(opts: { adapter?: AdapterId; probs: Partial<Record<Hypothesis['kind'], number>>; latencyMs: number; weight?: number }): Rescorer {
  const adapter = opts.adapter ?? 'hosted'
  const codec = codecFor(adapter)
  const response = syntheticResponse(adapter, codec.model, normalizeProbs(opts.probs))
  return {
    name: `cassette:${adapter}`,
    rescore(packet: ContextPacket, candidates: Hypothesis[], signal?: AbortSignal) {
      const request = codec.buildRequest(packet)
      const cassette: Cassette = {
        schema: CASSETTE_SCHEMA,
        adapter,
        model: codec.model,
        requestHash: requestHash(adapter, codec.model, request),
        requestSummary: { synthetic: 'per-packet' },
        request,
        response,
        latencyMs: opts.latencyMs,
        recordedAt: '2026-11-14T00:00:00.000Z',
        synthetic: true,
      }
      const r = new CassetteRescorer({ codec, cassettes: [cassette], weight: opts.weight ?? settings.weight, latencyMs: opts.latencyMs })
      return r.rescore(packet, candidates, signal)
    },
  } as Rescorer
}
