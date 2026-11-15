/**
 * Selection UI (docs/tasks/S1-select-and-retype.md):
 *  - SelectionOverlay (sheet overlay): the selected drawn elements and host elements, and a marker on every host
 *    element whose type was changed this session ("→ Exterior - 300mm")
 *  - TypeMenu: the popover the right click opens: read as (drawn elements), then the types of their category
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react'
import type { Path, Point, Sheet } from '@core/types'
import type { Placement } from '../board/layout'
import { useSession } from '../session'
import { useDocState } from '../store'
import { itemsOf } from '../drawing/inspect'
import { shapes } from '../drawing/InspectLayers'
import { KIND_LABEL } from '../brain/overlays'
import { elementBox, menuModel, resolveSelection, selection, setKind, setType, useSelection } from './selection'
import { typeLabel } from './types'
import { askRevitTypes, useRevitTypesVersion } from './revitTypes'
import { entryFor, useRevit } from '../revit/controller'

const px = (n: number) => `calc(${n}px / var(--z))`
const d = (pts: readonly Point[], closed = false) => (pts.length ? `M${pts.map((p) => `${p.x} ${p.y}`).join('L')}${closed ? 'Z' : ''}` : '')

/** Registered as a sheet overlay: what is selected on this sheet, and the pending type changes. */
export function SelectionOverlay({ sheet }: { sheet: Sheet; placement: Placement }) {
  const { items } = useSelection()
  const { accepted, strokes, commands, hidden } = useSession()
  const { source } = useDocState()
  const { resultsRev } = useRevit()
  const vp = source?.vectorPage?.(sheet.id) ?? null

  const drawn = useMemo(() => {
    const ids = new Set(items.flatMap((s) => (s.t === 'drawn' ? [s.strokeId] : [])))
    const out: { id: string; path: Path }[] = []
    for (const s of strokes) {
      if (!ids.has(s.id) || s.sheetId !== sheet.id || hidden.has(s.id)) continue
      const dec = accepted.find((a) => a.strokeId === s.id)
      out.push({ id: s.id, path: dec ? dec.geometry : { points: s.points, closed: false } })
    }
    return out
  }, [items, accepted, strokes, hidden, sheet.id])

  const hostIds = useMemo(() => items.flatMap((s) => (s.t === 'sheet' ? [s.id] : [])), [items])
  const host = useMemo(() => {
    if (!vp || !hostIds.length) return null
    const its = itemsOf(vp.page, hostIds)
    return its.length ? shapes(its) : null
  }, [vp, hostIds])

  // pending type changes on host elements, marked where each element is drawn on this sheet, until the linked model
  // has redrawn the element with its new type
  const marks = useMemo(() => {
    if (!vp) return []
    const out: { id: string; box: { x: number; y: number; w: number; h: number }; label: string }[] = []
    const seen = new Set<string>()
    for (let i = commands.length - 1; i >= 0; i--) {
      const c = commands[i]
      if (c.op !== 'set_type') continue
      const landed = !!entryFor(c.id)?.landed
      for (const id of c.targets) {
        if (seen.has(id)) continue
        seen.add(id)
        if (landed) continue
        const box = elementBox(itemsOf(vp.page, [id]))
        if (box) out.push({ id, box, label: typeLabel(c.family, c.typeName) })
      }
    }
    return out
    // resultsRev: a set_type landing in the linked model clears its mark
  }, [vp, commands, resultsRev])

  if (!drawn.length && !host && !marks.length) return null
  return (
    <g data-layer="selection">
      {marks.map((m) => (
        <g key={m.id} className="type-mark" data-testid="type-mark" data-element={m.id} data-type={m.label}>
          <rect x={m.box.x - 2} y={m.box.y - 2} width={m.box.w + 4} height={m.box.h + 4} style={{ strokeWidth: px(1.2), strokeDasharray: `${px(4)} ${px(3)}` }} />
          <text x={m.box.x + m.box.w + 3} y={m.box.y - 3} style={{ fontSize: px(11) }}>
            → {m.label}
          </text>
        </g>
      ))}
      {host && (
        <g className="select-hl" data-testid="selected-sheet" data-items={hostIds.join(',')}>
          {host.fills && <path className="fill" d={host.fills} fillRule="evenodd" />}
          {host.lines && <path className="line" d={host.lines} style={{ strokeWidth: `calc(${host.maxW}px + 6px / var(--z))` }} />}
          {host.rects.map((b, i) => (
            <rect key={i} className="box" x={b.x} y={b.y} width={b.w} height={b.h} style={{ strokeWidth: px(2) }} />
          ))}
          {host.quads.map((q, i) => (
            <polygon key={i} className="box" points={q} style={{ strokeWidth: px(2) }} />
          ))}
        </g>
      )}
      {drawn.map((s) => (
        <path key={s.id} className="select-drawn" data-testid="selected-drawn" data-stroke-id={s.id} d={d(s.path.points, s.path.closed)} style={{ strokeWidth: px(10) }} />
      ))}
    </g>
  )
}

/** The type menu, at the right click. */
export function TypeMenu() {
  const { menu, items } = useSelection()
  const session = useSession()
  const ref = useRef<HTMLDivElement>(null)
  const typesVersion = useRevitTypesVersion()
  const model = useMemo(() => (menu ? menuModel(resolveSelection(items)) : null), [menu, items, session.accepted, session.commands, session.strokes, typesVersion])

  // S1-07: one host element of a linked sheet: ask Revit for every type it allows (the menu updates when it answers)
  useEffect(() => {
    if (!menu) return
    const rs = resolveSelection(items)
    if (rs.length === 1 && rs[0].t === 'sheet') askRevitTypes(rs[0].sheetId, rs[0].id)
  }, [menu, items])

  // keep the menu on screen, focus its first row; any press outside closes it
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !menu) return
    const r = el.getBoundingClientRect()
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8))}px`
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8))}px`
    el.querySelector<HTMLButtonElement>('button[aria-checked="true"], button')?.focus({ preventScroll: true })
    const away = (e: PointerEvent) => {
      if (el.contains(e.target as Node)) return
      selection.closeMenu()
      // the press that closes the menu does nothing else (no stray brush dot on the sheet)
      if ((e.target as Element | null)?.closest?.('[data-testid="board"]') && e.button !== 2) e.stopPropagation()
    }
    const blur = () => selection.closeMenu()
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('blur', blur)
    }
  }, [menu])

  if (!menu || !model) return null

  const onKey = (e: KeyboardEvent) => {
    const rows = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = rows.length
      rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      selection.closeMenu()
    }
  }
  const pick = (f: () => void) => () => {
    f()
    selection.closeMenu()
  }

  return (
    <div
      ref={ref}
      className="menu app-menu type-menu"
      role="menu"
      aria-label="Change type"
      data-testid="type-menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="type-menu-title" data-testid="type-menu-title">
        {model.title}
      </div>
      {model.readAs && (
        <>
          <div className="type-menu-head">Read as</div>
          {model.readAs.kinds.map((k) => (
            <button key={k} type="button" role="menuitemradio" aria-checked={model.readAs!.current === k} data-kind={k} onClick={pick(() => setKind(k))}>
              <span>{KIND_LABEL[k]}</span>
              {model.readAs!.current === k && <span className="check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </>
      )}
      {model.types && (
        <>
          {model.readAs && <div className="menu-sep" />}
          <div className="type-menu-head">Type</div>
          <div className="type-menu-list" data-testid="type-menu-types">
            {model.types.options.map((o) => (
              <button key={o.label} type="button" role="menuitemradio" aria-checked={model.types!.current === o.label} data-type={o.label} title={o.label} onClick={pick(() => setType(o))}>
                <span className="name">{o.label}</span>
                {model.types!.current === o.label ? (
                  <span className="check" aria-hidden="true">✓</span>
                ) : (
                  model.types!.original === o.label && <span className="mono-num">original</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
      {model.note && <div className="type-menu-note">{model.note}</div>}
    </div>
  )
}
