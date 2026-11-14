import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, ContextItem, SheetContext } from '../../../src/core/types'
import { erasedElements, withoutErased } from '../../../src/core/context'

const item = (id: string, hostRef?: string): ContextItem => ({ id, kind: 'wall', geometry: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }, confidence: 1, ...(hostRef ? { hostRef } : {}) })
const plan: SheetContext = { sheetId: 'plan', origin: 'package', items: [item('wall-1a', '1'), item('wall-1b', '1'), item('wall-2', '2'), item('inferred-3')] }
const axo: SheetContext = { sheetId: 'axo', origin: 'package', items: [item('wall-1x', '1'), item('wall-2x', '2')] }
const ctxOf = (id: string) => (id === 'plan' ? plan : id === 'axo' ? axo : undefined)
const del = (sheetId: string, targets: string[], strokeId = 's'): AcceptedDecision => ({ strokeId, sheetId, kind: 'delete', geometry: { points: [], closed: false }, confidence: 1, targets, committedAt: 0 })

describe('M3-03 erasing drawing elements', () => {
  it('M3-03: an accepted delete names the host elements of its targets; other kinds and unknown items name none', () => {
    const acc = [del('plan', ['wall-1a', 'inferred-3', 'nope']), { ...del('plan', ['wall-2']), kind: 'wall' as const }]
    expect([...erasedElements(acc, ctxOf)]).toEqual(['1'])
  })

  it('M3-03: erased elements leave the context of every sheet (all their pieces); targets without a host leave their own sheet', () => {
    const acc = [del('plan', ['wall-1a', 'inferred-3'])]
    const refs = erasedElements(acc, ctxOf)
    expect(withoutErased(plan, acc, refs).items.map((i) => i.id)).toEqual(['wall-2'])
    expect(withoutErased(axo, acc, refs).items.map((i) => i.id)).toEqual(['wall-2x'])
  })

  it('M3-03: with nothing erased the context object is returned unchanged', () => {
    expect(withoutErased(plan, [], new Set())).toBe(plan)
  })
})
