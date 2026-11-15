import { describe, expect, it } from 'vitest'
import type { AcceptedDecision, ContextItem, SheetContext } from '../../../src/core/types'
import { erasedElements } from '../../../src/core/context'

const item = (id: string, hostRef?: string): ContextItem => ({ id, kind: 'wall', geometry: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }, confidence: 1, ...(hostRef ? { hostRef } : {}) })
const plan: SheetContext = { sheetId: 'plan', origin: 'package', items: [item('wall-1a', '1'), item('wall-1b', '1'), item('wall-2', '2'), item('inferred-3')] }
const ctxOf = (id: string) => (id === 'plan' ? plan : undefined)
const del = (sheetId: string, targets: string[]): AcceptedDecision => ({ strokeId: 's', sheetId, kind: 'delete', geometry: { points: [], closed: false }, confidence: 1, targets, committedAt: 0 })

describe('M3-03 erasing drawing elements', () => {
  it('M3-03: an accepted delete names the host elements of its targets; other kinds and unknown items name none', () => {
    const acc = [del('plan', ['wall-1a', 'inferred-3', 'nope']), { ...del('plan', ['wall-2']), kind: 'wall' as const }, del('elsewhere', ['wall-2'])]
    expect([...erasedElements(acc, ctxOf)]).toEqual(['1'])
  })
})
