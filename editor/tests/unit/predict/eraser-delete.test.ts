import { describe, expect, it } from 'vitest'
import { polyStroke, replayStroke, settings, testContext } from './helpers'

describe('M3-03 eraser over the drawing', () => {
  it('M3-03: an eraser pass back and forth over a wall reads as a delete of that wall', () => {
    const s = polyStroke([{ x: 420, y: 92 }, { x: 440, y: 108 }, { x: 445, y: 92 }, { x: 462, y: 108 }], { tool: 'eraser' })
    const h = replayStroke(s, testContext(), settings()).final
    expect(h.kind).toBe('delete')
    expect(h.targets).toEqual(['wall-h'])
  })
})
