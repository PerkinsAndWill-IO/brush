import type { AcceptedDecision, SheetContext } from '../types'

/** Host element ids are bare integers (Revit element ids), never context item ids like `wall-12` or `cmd-0001`. */
const ELEMENT_ID = /^\d+$/

/**
 * Host elements (hostRef, e.g. a Revit / .drawing element id) removed by accepted deletes: an eraser pass or a
 * scribble over an item of a package context. Element ids are shared by all pages of a source, so the element is
 * gone from every sheet. Targets without a hostRef (inferred from a plain PDF) name no element. A target that is no
 * item of a package context but a bare element id (an element the context has no item for: the eraser names it
 * directly) is that element. (The brush's context drops deleted items itself: withSessionElements.)
 */
export function erasedElements(accepted: readonly AcceptedDecision[], ctxOf: (sheetId: string) => SheetContext | undefined): Set<string> {
  const out = new Set<string>()
  for (const a of accepted) {
    if (a.kind !== 'delete' || !a.targets?.length) continue
    const ctx = ctxOf(a.sheetId)
    if (!ctx) continue
    for (const t of a.targets) {
      const item = ctx.items.find((i) => i.id === t)
      if (item?.hostRef) out.add(item.hostRef)
      else if (!item && ctx.origin === 'package' && ELEMENT_ID.test(t)) out.add(t)
    }
  }
  return out
}
