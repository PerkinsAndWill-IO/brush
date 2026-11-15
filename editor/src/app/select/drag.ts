/**
 * S2-07: the pure parts of dragging and of the clipboard keys on the board.
 */
import type { Point } from '@core/types'

/** A press must move this far on screen before it is a drag; below it, it stays a click (S1 selection). */
export const DRAG_THRESHOLD_PX = 4

/** Sheet offset of a drag (screen distance / zoom `z`), or null while it is still a click. */
export function dragOffset(downScreen: Point, nowScreen: Point, z: number): { dx: number; dy: number } | null {
  const sx = nowScreen.x - downScreen.x
  const sy = nowScreen.y - downScreen.y
  if (Math.hypot(sx, sy) < DRAG_THRESHOLD_PX) return null
  return { dx: sx / z, dy: sy / z }
}

const typing = (t: EventTarget | null): boolean => {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = (el.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** Ctrl/Cmd+C or +V that the board should handle: not while typing in an input, textarea, select or editable text. */
export function isClipboardKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'target'>): 'copy' | 'paste' | null {
  if (!(e.ctrlKey || e.metaKey) || typing(e.target)) return null
  const k = e.key.toLowerCase()
  return k === 'c' ? 'copy' : k === 'v' ? 'paste' : null
}
