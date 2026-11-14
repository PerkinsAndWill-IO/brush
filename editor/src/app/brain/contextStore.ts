/**
 * Sheet contexts for the open document (M2). Built off the main thread by the
 * context worker (src/app/context/client.ts, context lane) in the background
 * right after a document opens, one sheet at a time, then cached here so the
 * brush can read them synchronously on pen-down.
 *
 * Seam for M5: a `.drawing` package supplies its own ContextProvider (contexts
 * from the manifest, origin 'package') through `OpenedSource.context` in store.ts.
 */
import { useSyncExternalStore } from 'react'
import type { SheetContext } from '@core/types'
import { createContextClient } from '../context/client'

/** What the app needs from a context source. The context worker client satisfies it. */
export interface ContextProvider {
  open(source: string | ArrayBuffer | Uint8Array): Promise<void>
  getContext(sheetId: string): Promise<SheetContext>
  close(): void
}

export type ContextStatus = 'pending' | 'ready' | 'error'

interface State {
  generation: number
  status: ReadonlyMap<string, ContextStatus>
  contexts: ReadonlyMap<string, SheetContext>
}

let provider: ContextProvider | null = null
/** Resolves once the provider has the document (builds wait for it). */
let opening: Promise<boolean> = Promise.resolve(false)
let state: State = { generation: 0, status: new Map(), contexts: new Map() }
const listeners = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useContexts = () => useSyncExternalStore(subscribe, () => state)

/** Synchronous read for the brush hot path; undefined until built. */
export const contextNow = (sheetId: string): SheetContext | undefined => state.contexts.get(sheetId)

/** Context for a sheet; builds it now if the background pass has not reached it yet. Null on failure / no document. */
export async function contextFor(sheetId: string): Promise<SheetContext | null> {
  const hit = state.contexts.get(sheetId)
  if (hit) return hit
  if (!provider) return null
  return load(sheetId, state.generation)
}

async function load(sheetId: string, gen: number): Promise<SheetContext | null> {
  const p = provider
  if (!p) return null
  if (!(await opening) || gen !== state.generation) return null
  try {
    const ctx = await p.getContext(sheetId)
    if (gen !== state.generation) return null
    const contexts = new Map(state.contexts).set(sheetId, ctx)
    emit({ contexts, status: new Map(state.status).set(sheetId, 'ready') })
    return ctx
  } catch (e) {
    if (gen === state.generation) {
      console.warn(`context for ${sheetId} failed`, e)
      emit({ status: new Map(state.status).set(sheetId, 'error') })
    }
    return null
  }
}

/**
 * Bind contexts to a newly opened document and build every sheet in the
 * background (page order). `bytes` must be a copy the caller no longer needs.
 */
export async function openContexts(source: string | Uint8Array, sheetIds: readonly string[], custom?: ContextProvider): Promise<void> {
  closeContexts()
  const gen = state.generation + 1
  provider = custom ?? createContextClient()
  emit({ generation: gen, status: new Map(sheetIds.map((id) => [id, 'pending' as const])), contexts: new Map() })
  const p = provider
  opening = p.open(source).then(
    () => true,
    (e) => {
      if (gen === state.generation) {
        console.warn('context worker could not open the document', e)
        emit({ status: new Map(sheetIds.map((id) => [id, 'error' as const])) })
      }
      return false
    },
  )
  if (!(await opening)) return
  for (const id of sheetIds) {
    if (gen !== state.generation) return
    await load(id, gen)
  }
}

export function closeContexts() {
  provider?.close()
  provider = null
  emit({ generation: state.generation + 1, status: new Map(), contexts: new Map() })
}

/** Shape-only stand-in until (or unless) the real context exists: the brush falls back to stroke shape alone. */
export function emptyContext(sheetId: string): SheetContext {
  return { sheetId, origin: 'inferred', items: [], shapeOnly: true }
}
