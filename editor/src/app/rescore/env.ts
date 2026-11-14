/**
 * Second-pass settings from Vite env (.env.local, never committed — AGENTS.md rule 9).
 *
 *   VITE_BRUSH_RESCORER=off|local|hosted|jev
 *   VERCEL_AI_GATEWAY_API_KEY=...     Server-side only (no VITE_ prefix, never in the bundle). In `pnpm dev`
 *                                     the Vite proxy at /ai-gateway injects it; the hosted adapter
 *                                     defaults to that path in dev. Production/Tauri: a proxy you own.
 *   VITE_BRUSH_HOSTED_BASE_URL=...    override, e.g. your production proxy
 *   VITE_BRUSH_LOCAL_URL=...          default http://127.0.0.1:8080/v1/chat/completions
 *   VITE_BRUSH_JEV_URL=...            default http://127.0.0.1:8765/v1/decide
 */
import { DEFAULT_RESCORE_SETTINGS, type RescoreAdapterSetting, type RescoreSettings } from '@core/rescore'

const ADAPTER_VALUES: RescoreAdapterSetting[] = ['off', 'local', 'hosted', 'jev']

export function rescoreSettingsFromEnv(): { settings: RescoreSettings; apiKey?: string } {
  const env = import.meta.env
  const settings: RescoreSettings = { ...DEFAULT_RESCORE_SETTINGS }
  const adapter = env.VITE_BRUSH_RESCORER as string | undefined
  if (adapter && (ADAPTER_VALUES as string[]).includes(adapter)) settings.adapter = adapter as RescoreAdapterSetting
  if (env.DEV) settings.hostedBaseUrl = `${globalThis.location?.origin ?? ''}/ai-gateway`
  if (env.VITE_BRUSH_HOSTED_BASE_URL) settings.hostedBaseUrl = env.VITE_BRUSH_HOSTED_BASE_URL as string
  if (env.VITE_BRUSH_LOCAL_URL) settings.localUrl = env.VITE_BRUSH_LOCAL_URL as string
  if (env.VITE_BRUSH_JEV_URL) settings.jevUrl = env.VITE_BRUSH_JEV_URL as string
  // No key in the browser: the dev proxy (or your production proxy) adds it.
  return { settings }
}
