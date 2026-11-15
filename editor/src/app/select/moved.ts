/**
 * S2-07: host elements moved on the board leave their old place at once. Until Revit sends a sheet with the element
 * at its new place (or forever, for a `.drawing` without a link), the old place is hidden (through the display
 * filters' hidden set) and the element is drawn at the new one. PURE.
 */
import type { Command } from '@core/types'

/** Host element ids with a `move` that has not landed (Revit has not redrawn them yet). */
export function movedHostElements(commands: readonly Command[], landed: (commandId: string) => boolean): Set<string> {
  const out = new Set<string>()
  for (const c of commands) if (c.op === 'move' && !landed(c.id)) for (const t of c.targets) out.add(t)
  return out
}
