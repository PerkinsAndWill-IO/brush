import { browserPlatform } from './browser'
import type { Platform } from './types'

export type { OpenedFile, Platform, SidecarKey } from './types'
export { sidecarPathFor } from './types'

/** True inside the Tauri webview (same check as @tauri-apps/api/core isTauri). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let cached: Promise<Platform> | null = null

/** Resolve the platform once. Tauri code is behind a dynamic import. */
export function getPlatform(): Promise<Platform> {
  cached ??= isTauri() ? import('./tauri').then((m) => m.tauriPlatform) : Promise.resolve(browserPlatform)
  return cached
}
