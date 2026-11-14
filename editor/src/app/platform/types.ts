import type { SessionFile } from '@core/types'

/** A PDF the user opened (dialog, file input or drop). */
export interface OpenedFile {
  name: string
  size: number
  bytes: ArrayBuffer
  /** Absolute path on disk; Tauri only. */
  path?: string
}

/** Identifies the sidecar `<name>.brush.json` for a PDF. */
export interface SidecarKey {
  name: string
  size: number
  /** Absolute PDF path; when present (Tauri) the sidecar is written next to it. */
  path?: string
}

/**
 * Everything shell-specific lives behind this interface (spec: "Anything
 * Tauri-specific sits behind a small platform adapter with a browser fallback").
 */
export interface Platform {
  readonly kind: 'web' | 'tauri'
  /** Ask the user for a PDF. Resolves null when cancelled. */
  openPdf(): Promise<OpenedFile | null>
  readSidecar(key: SidecarKey): Promise<SessionFile | null>
  writeSidecar(key: SidecarKey, session: SessionFile): Promise<void>
  /**
   * Subscribe to OS-level file drops (Tauri). The web build handles drops with
   * DOM events in the UI and returns a no-op unsubscribe here.
   */
  onFileDrop(cb: (file: OpenedFile) => void): Promise<() => void>
}

export function sidecarPathFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, '') + '.brush.json'
}

export function sidecarStorageKey(key: SidecarKey): string {
  return `brush.sidecar:${key.name}:${key.size}`
}
