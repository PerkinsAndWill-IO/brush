/**
 * Side panels: the board takes the whole width, and what used to be the left and right sidebars sits behind a slim
 * rail of icons on each edge. A click on an icon opens its panel, a floating card over the board that slides in from
 * its own edge; a click on the same icon, or Esc while it has focus, closes it. Panels stay open while drawing (the
 * reading panel can follow a stroke), and start closed on every load.
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

export type Side = 'left' | 'right'

export interface PanelItem {
  id: string
  label: string
  icon: ReactNode
  /** A dot on the icon: there is something to see (an element selected). */
  badge?: boolean
  content: ReactNode
}

let state: Record<Side, string | null> = { left: null, right: null }
const listeners = new Set<() => void>()
const set = (side: Side, id: string | null) => {
  if (state[side] === id) return
  state = { ...state, [side]: id }
  listeners.forEach((l) => l())
}

export const sidePanels = {
  open: (side: Side, id: string) => set(side, id),
  close: (side: Side) => set(side, null),
  toggle: (side: Side, id: string) => set(side, state[side] === id ? null : id),
  get: () => state,
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const useSidePanels = () => useSyncExternalStore(subscribe, sidePanels.get)

export function SideDock({ side, items, testId, label, wide = false }: { side: Side; items: readonly PanelItem[]; testId: string; label: string; wide?: boolean }) {
  const open = useSidePanels()[side]
  const item = items.find((i) => i.id === open) ?? null
  const panel = useRef<HTMLElement>(null)

  // an item that is gone (the tool changed and its panel with it) closes
  useEffect(() => {
    if (open !== null && !items.some((i) => i.id === open)) sidePanels.close(side)
  }, [open, items, side])

  return (
    <div className={`side-dock ${side}`}>
      <nav className="side-rail" aria-label={label}>
        {items.map((i) => (
          <button
            key={i.id}
            type="button"
            className="rail-btn"
            aria-pressed={open === i.id}
            aria-label={i.label}
            title={i.label}
            data-testid={`rail-${i.id}`}
            onClick={() => sidePanels.toggle(side, i.id)}
          >
            {i.icon}
            {i.badge && <span className="rail-dot" aria-hidden="true" />}
          </button>
        ))}
      </nav>
      {item && (
        <aside
          ref={panel}
          key={item.id}
          className={`side-panel sidebar ${side}${wide ? ' wide' : ''}`}
          aria-label={item.label}
          data-testid={testId}
          data-panel={item.id}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            sidePanels.close(side)
          }}
        >
          {item.content}
        </aside>
      )}
    </div>
  )
}
