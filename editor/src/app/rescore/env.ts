/**
 * Second-pass settings from Vite env (.env.local, never committed — AGENTS.md rule 9).
 *
 *   VITE_BRUSH_RESCORER=off|local|hosted|jev
 *   VITE_ANTHROPIC_API_KEY=...        DEV ONLY. Any VITE_* value is inlined into the JS bundle;
 *                                     the key is read only when import.meta.env.DEV, but do not keep
 *                                     it in .env.local when running `pnpm build`. Production: proxy.
 *   VITE_BRUSH_HOSTED_BASE_URL=...    e.g. your proxy that injects the key server-side
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
  if (env.VITE_BRUSH_HOSTED_BASE_URL) settings.hostedBaseUrl = env.VITE_BRUSH_HOSTED_BASE_URL as string
  if (env.VITE_BRUSH_LOCAL_URL) settings.localUrl = env.VITE_BRUSH_LOCAL_URL as string
  if (env.VITE_BRUSH_JEV_URL) settings.jevUrl = env.VITE_BRUSH_JEV_URL as string
  const apiKey = env.DEV ? (env.VITE_ANTHROPIC_API_KEY as string | undefined) : undefined
  return apiKey ? { settings, apiKey } : { settings }
}
