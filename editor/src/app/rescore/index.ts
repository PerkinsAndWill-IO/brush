/**
 * app/rescore — the M4 second pass wired for the app. Usage from the engine:
 *
 *   const { settings, apiKey } = rescoreSettingsFromEnv()          // or from the settings UI
 *   const second = createSecondPass(settings, { apiKey, onResult }) // null when adapter is 'off'
 *   // pen up (after session.end()), never awaited:
 *   second?.runner.consider({ strokeId, run: h.run, packet: buildContextPacket({ stroke, ctx, evidence }, h, history), candidates: [h] })
 *   // onResult(r): switch (resolveAnswer(r, { strokeId: live.id, run: live.h?.run, committed: acceptedFor(r.strokeId) }, settings).action)
 *   //   'apply'   -> show r.hypotheses[0] as the live hypothesis (before commit only)
 *   //   'suggest' -> add a suggestion chip to the committed stroke (rule 6: never re-decides)
 *   //   'drop'    -> nothing
 *   // metrics: second.runner.secondPassMs (ms per answered call) -> secondPassP95Ms
 */
import { RescoreRunner, type RescoreResult, type RescoreSettings } from '@core/rescore'
import { createRescorer } from './adapters'
import type { FetchLike } from './http'

export { createRescorer, hostedRescorer, jevRescorer, localRescorer, ANTHROPIC_VERSION } from './adapters'
export { HttpRescorer, postJson, RescoreHttpError, RescoreTimeoutError } from './http'
export type { FetchLike, HttpRescorerOptions } from './http'
export { rescoreSettingsFromEnv } from './env'

export function createSecondPass(
  settings: RescoreSettings,
  opts: { apiKey?: string; fetch?: FetchLike; onResult: (r: RescoreResult) => void },
): { runner: RescoreRunner; settings: RescoreSettings } | null {
  const rescorer = createRescorer(settings, opts)
  if (!rescorer) return null
  const runner = new RescoreRunner({ rescorer, settings, now: () => performance.now(), onResult: opts.onResult })
  return { runner, settings }
}
