/**
 * Is the Revit conversion server (`.rvt` → `.drawing`, see CLAUDE.md) there? It is not part of this repo and is not
 * deployed: a production build only has one when `VITE_RVT_CONVERT_URL` names it. Dev and test builds default to a
 * server on this computer. The start page asks once and says so when it is missing, so nobody picks a model for nothing.
 */
import { useEffect, useSyncExternalStore } from 'react'

const DEV = import.meta.env.DEV || import.meta.env.VITE_TEST === '1'

/**
 * Where a Revit model goes to become a `.drawing`: a conversion server that answers `POST` (the model's bytes, its
 * URI-encoded name in `X-Filename`) with the `.drawing` file, or (asked with `Prefer: respond-async`) with where to
 * follow the conversion's progress (`convertClient.ts`). Undefined when this build has none.
 */
export const RVT_CONVERT_URL: string | undefined = import.meta.env.VITE_RVT_CONVERT_URL || (DEV ? 'http://127.0.0.1:4100/convert' : undefined)

export const RVT_UNAVAILABLE = 'Opening Revit models (.rvt) isn’t available yet. You can open a sample or upload a PDF.'

const PROBE_TIMEOUT_MS = 3000

export type ConverterStatus = 'checking' | 'available' | 'unavailable'

let status: ConverterStatus = RVT_CONVERT_URL ? 'checking' : 'unavailable'
let probing: Promise<void> | undefined
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function setConverterStatus(next: ConverterStatus): void {
  if (next === status) return
  status = next
  listeners.forEach((l) => l())
}

/** Once per page: any answer at all (CORS or not, any status) means the server is there; no answer in time means it is not. */
function probeConverter(): void {
  if (!RVT_CONVERT_URL) return
  probing ??= fetch(RVT_CONVERT_URL, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).then(
    () => setConverterStatus('available'),
    () => setConverterStatus('unavailable'),
  )
}

/** The server's status, probed the first time a component asks. */
export function useConverterStatus(): ConverterStatus {
  useEffect(probeConverter, [])
  return useSyncExternalStore(subscribe, () => status)
}
