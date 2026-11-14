/**
 * Tauri 2 implementation. Only loaded via dynamic import from ./index.ts when
 * running inside the Tauri webview, so the web build never needs Tauri.
 * APIs checked against node_modules/@tauri-apps/{plugin-dialog,plugin-fs,api}.
 * The sidecar is written next to the PDF as `<name>.brush.json`.
 */
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { exists, readFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import type { SessionFile } from '@core/types'
import { browserPlatform } from './browser'
import { sidecarPathFor, type OpenedFile, type Platform, type SidecarKey } from './types'

async function readPdfAt(path: string): Promise<OpenedFile> {
  const data = await readFile(path)
  const name = path.split(/[\\/]/).pop() ?? path
  return { name, size: data.byteLength, bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), path }
}

export const tauriPlatform: Platform = {
  kind: 'tauri',
  async openPdf() {
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Drawings', extensions: ['pdf', 'drawing'] }] })
    return path ? readPdfAt(path) : null
  },
  async readSidecar(key: SidecarKey) {
    if (!key.path) return browserPlatform.readSidecar(key)
    const p = sidecarPathFor(key.path)
    if (!(await exists(p))) return null
    return JSON.parse(await readTextFile(p)) as SessionFile
  },
  async writeSidecar(key: SidecarKey, session: SessionFile) {
    if (!key.path) return browserPlatform.writeSidecar(key, session)
    await writeTextFile(sidecarPathFor(key.path), JSON.stringify(session, null, 2))
  },
  // The fs scope only allows *.brush.json sidecars; recordings use the webview's download (browser path).
  saveTextFile: (name, text) => browserPlatform.saveTextFile(name, text),
  async onFileDrop(cb) {
    return getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== 'drop') return
      const pdf = event.payload.paths.find((p) => /\.(pdf|drawing)$/i.test(p)) ?? event.payload.paths[0]
      if (pdf) cb(await readPdfAt(pdf))
    })
  },
}
