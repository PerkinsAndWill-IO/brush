/**
 * S1-07: the types Revit allows for host elements of linked sheets, asked once per element when the type menu opens
 * (`list_types`) and kept until the link drops. The menu shows the document's types at once and Revit's full list as
 * soon as it is here; an older plugin, an error or a slow answer leaves the document's.
 */
import { useSyncExternalStore } from 'react'
import { revit } from '../revit/controller'
import type { RevitTypes } from '../revit/types'

type Entry = RevitTypes | 'asking' | null

const cache = new Map<string, Entry>()
let version = 0
const listeners = new Set<() => void>()
const bump = () => {
  version++
  listeners.forEach((l) => l())
}
const key = (pageId: string, elementId: string) => `${pageId}|${elementId}`

/** Revit's types for the element, when they came; undefined while asking or when Revit cannot say. */
export function revitTypesOf(pageId: string, elementId: string): RevitTypes | undefined {
  const e = cache.get(key(pageId, elementId))
  return e && e !== 'asking' ? e : undefined
}

/** Ask Revit once for the element's types (only answered for elements of linked sheets). */
export function askRevitTypes(pageId: string, elementId: string): void {
  const k = key(pageId, elementId)
  const had = cache.get(k)
  if (had === 'asking' || (had && had.types.length)) return // asked, or answered; a failed answer is asked again
  cache.set(k, 'asking')
  void revit.listTypes(elementId, pageId).then((t) => {
    cache.set(k, t)
    bump()
  })
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
/** Re-renders when an answer arrives. */
export const useRevitTypesVersion = (): number => useSyncExternalStore(subscribe, () => version)
