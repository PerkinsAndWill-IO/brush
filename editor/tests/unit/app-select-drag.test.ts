import { describe, expect, it } from 'vitest'
import { DRAG_THRESHOLD_PX, dragOffset, isClipboardKey } from '../../src/app/select/drag'

describe('S2-07 dragging', () => {
  it('S2-07: under the threshold a press is a click (null offset)', () => {
    expect(DRAG_THRESHOLD_PX).toBe(4)
    expect(dragOffset({ x: 100, y: 100 }, { x: 103, y: 102 }, 2)).toBeNull()
  })

  it('S2-07: past it the offset is in sheet points (screen / z)', () => {
    expect(dragOffset({ x: 100, y: 100 }, { x: 140, y: 90 }, 2)).toEqual({ dx: 20, dy: -5 })
  })
})

describe('S2-07 clipboard keys', () => {
  const div = { tagName: 'DIV', isContentEditable: false }
  it('S2-07: Ctrl+C in a text input is not the board\'s', () => {
    expect(isClipboardKey({ key: 'c', ctrlKey: true, metaKey: false, target: { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget })).toBeNull()
    expect(isClipboardKey({ key: 'c', ctrlKey: true, metaKey: false, target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget })).toBeNull()
    expect(isClipboardKey({ key: 'c', ctrlKey: true, metaKey: false, target: div as unknown as EventTarget })).toBe('copy')
    expect(isClipboardKey({ key: 'c', ctrlKey: false, metaKey: false, target: div as unknown as EventTarget })).toBeNull()
  })

  it('S2-07: Cmd+V is paste', () => {
    expect(isClipboardKey({ key: 'V', ctrlKey: false, metaKey: true, target: div as unknown as EventTarget })).toBe('paste')
  })
})
