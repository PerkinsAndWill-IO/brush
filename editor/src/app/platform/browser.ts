/**
 * Browser fallback: file input for open, IndexedDB for the sidecar (keyed by
 * PDF name + size), localStorage if IndexedDB is unavailable.
 */
import type { SessionFile } from '@core/types'
import { sidecarStorageKey, type OpenedFile, type Platform, type SidecarKey } from './types'

const DB_NAME = 'brush'
const STORE = 'sidecars'

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

async function idbGet(key: string): Promise<string | null | undefined> {
  const db = await openDb()
  if (!db) return undefined
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
    req.onerror = () => resolve(undefined)
  })
}

async function idbPut(key: string, value: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => resolve(false)
  })
}

export function fileToOpened(file: File): Promise<OpenedFile> {
  return file.arrayBuffer().then((bytes) => ({ name: file.name, size: file.size, bytes }))
}

export function pickFile(accept = 'application/pdf,.pdf,.drawing,application/json,application/zip'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null)
      input.remove()
    })
    input.addEventListener('cancel', () => {
      resolve(null)
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  })
}

// ───────────── File System Access (Chromium) ─────────────
// Picker types are not in lib.dom yet; minimal local declarations.
interface PickerType {
  description: string
  accept: Record<string, string[]>
}
interface FsWindow {
  showOpenFilePicker?: (o: { types?: PickerType[]; multiple?: boolean; excludeAcceptAllOption?: boolean }) => Promise<FileSystemFileHandle[]>
  showDirectoryPicker?: (o: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerType[] }) => Promise<FileSystemFileHandle>
}
type Permissioned = FileSystemHandle & {
  queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
}

const fsw = (): FsWindow => window as unknown as FsWindow
/** Real pickers only for people: automated browsers (Playwright) use the <input type=file> / download fallback. */
export const fsAccessAvailable = (): boolean => typeof window !== 'undefined' && typeof fsw().showOpenFilePicker === 'function' && !navigator.webdriver

const DRAWING_TYPES: PickerType[] = [{ description: 'PDF or .drawing package', accept: { 'application/pdf': ['.pdf'], 'application/json': ['.drawing'] } }]

/** Folder chosen for "Save to file" this session (one permission prompt). */
let saveDir: FileSystemDirectoryHandle | null = null

async function writable(h: Permissioned): Promise<boolean> {
  if (!h.queryPermission) return true
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return (await h.requestPermission?.({ mode: 'readwrite' })) === 'granted'
}

async function writeHandle(h: FileSystemFileHandle, text: string) {
  const w = await h.createWritable()
  await w.write(text)
  await w.close()
}

/**
 * Write files to disk with the File System Access API: into a folder the user picks once
 * per session (e.g. next to the PDF), or, without a directory picker, one save dialog per file.
 * Returns false when the API is missing or the user declined; callers then fall back to downloads.
 */
export async function saveFilesToDisk(files: { name: string; text: string }[]): Promise<boolean> {
  if (!fsAccessAvailable()) return false
  try {
    const w = fsw()
    if (w.showDirectoryPicker) {
      if (!saveDir || !(await writable(saveDir as Permissioned))) saveDir = await w.showDirectoryPicker({ mode: 'readwrite', id: 'brush-save' })
      for (const f of files) await writeHandle(await saveDir.getFileHandle(f.name, { create: true }), f.text)
      return true
    }
    if (!w.showSaveFilePicker) return false
    for (const f of files) await writeHandle(await w.showSaveFilePicker({ suggestedName: f.name, types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] }), f.text)
    return true
  } catch (e) {
    if ((e as DOMException)?.name !== 'AbortError') console.warn('save to disk failed', e)
    return false
  }
}

export const browserPlatform: Platform = {
  kind: 'web',
  async openPdf() {
    if (fsAccessAvailable()) {
      try {
        const [h] = await fsw().showOpenFilePicker!({ types: DRAWING_TYPES, multiple: false })
        return h ? fileToOpened(await h.getFile()) : null
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return null
        console.warn('file picker failed, using the file input', e)
      }
    }
    const file = await pickFile()
    return file ? fileToOpened(file) : null
  },
  async readSidecar(key: SidecarKey) {
    const k = sidecarStorageKey(key)
    let raw = await idbGet(k)
    if (raw === undefined) raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as SessionFile) : null
  },
  async writeSidecar(key: SidecarKey, session: SessionFile) {
    const k = sidecarStorageKey(key)
    const raw = JSON.stringify(session)
    if (!(await idbPut(k, raw))) localStorage.setItem(k, raw)
  },
  async onFileDrop() {
    return () => {}
  },
  saveFilesToDisk,
  async saveTextFile(suggestedName: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = suggestedName
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}
