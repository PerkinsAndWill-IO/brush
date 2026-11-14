/**
 * What the element card says about a picked element: tag resolution and readable labels. Pure; the card itself is
 * in the app. Same rules as the schema viewer's `elements.ts`.
 */
import type { DrawingElement } from './format'

/** "LinearDimString" -> "Linear dim string". */
export function classLabel(cls: string): string {
  const words = cls.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

export interface ResolvedElement {
  /** The element whose card is shown (the tagged element for a tag). */
  id: string
  info: DrawingElement | undefined
  /** Set when the picked element refers to another one (a tag): its class as words. */
  tagLabel: string | null
  /** Elements whose items are highlighted: the picked one first, then the tagged one. */
  highlight: string[]
}

export function resolveElement(elements: Record<string, DrawingElement>, id: string): ResolvedElement {
  const own = elements[id]
  const tagged = own?.tagged != null ? String(own.tagged) : null
  const target = tagged !== null ? elements[tagged] : undefined
  if (tagged === null || !target) return { id, info: own, tagLabel: null, highlight: [id] }
  return { id: tagged, info: target, tagLabel: classLabel(own.class ?? 'Tag'), highlight: [id, tagged] }
}

/** Card category line: category, else class as words, else "Element". */
export function categoryOf(info: DrawingElement | undefined): string {
  return info?.category || (info?.class ? classLabel(info.class) : '') || 'Element'
}

/** "SNAKE_CASE" -> "Snake case". Names that are not all caps and underscores pass through. */
export function paramLabel(name: string): string {
  if (!/^[A-Z0-9_]+$/.test(name)) return name
  const n = name.replace(/_+/g, ' ').trim().toLowerCase()
  return n.charAt(0).toUpperCase() + n.slice(1)
}
