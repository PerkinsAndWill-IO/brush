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

export function pickFile(accept = 'application/pdf,.pdf'): Promise<File | null> {
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

export const browserPlatform: Platform = {
  kind: 'web',
  async openPdf() {
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
}
