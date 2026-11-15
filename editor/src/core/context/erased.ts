import type { AcceptedDecision, SheetContext } from '../types'

/**
 * Host elements (hostRef, e.g. a Revit / .drawing element id) removed by accepted deletes: an eraser pass or a
 * scribble over an item of a package context. Element ids are shared by all pages of a source, so the element is
 * gone from every sheet. Targets without a hostRef (inferred from a plain PDF) name no element.
 * (The brush's context drops deleted items itself: withSessionElements.)
 */
export function erasedElements(accepted: readonly AcceptedDecision[], ctxOf: (sheetId: string) => SheetContext | undefined): Set<string> {
  const out = new Set<string>()
  for (const a of accepted) {
    if (a.kind !== 'delete' || !a.targets?.length) continue
    const ctx = ctxOf(a.sheetId)
    if (!ctx) continue
    for (const t of a.targets) {
      const ref = ctx.items.find((i) => i.id === t)?.hostRef
      if (ref) out.add(ref)
    }
  }
  return out
}
