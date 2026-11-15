/**
 * Inspect UI (docs/tasks/V3-inspect.md):
 *  - InspectOverlay (V3-01): on every sheet, the items of the hovered or pinned element (and the element a tag
 *    labels), drawn over the page in sheet points
 *  - ElementPanel  (V3-02/03): the element's metadata in the Select tool's sidebar panel; pinned by a click, with the sheets the
 *    element appears on (a click on one fits that sheet)
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { Sheet } from '@core/types'
import type { DrawItem } from '@core/drawing'
import type { Placement } from '../board/layout'
import { boardView } from '../board/Board'
import { getDocState, useDocState } from '../store'
import { hiddenPredicate, useFilters } from './filters'
import { roughMeasure, textQuad } from './hit'
import { cardCategory, inspect, itemsOf, paramLabel, resolveElement, shownElement, useInspect, type Resolved } from './inspect'

const px = (n: number) => `calc(${n}px / var(--z))`

/**
 * Highlight ids for the element on show, resolved against the elements of the open document. `pinnedOnly`: the
 * element pinned by a click, not the one under the pointer (the panel shows only what was selected).
 */
function useResolved(pinnedOnly = false): Resolved | null {
  const s = useInspect()
  const { source, sheets } = useDocState()
  const id = pinnedOnly ? s.pinned : shownElement(s)
  return useMemo(() => {
    if (id === null || !source?.vectorPage) return null
    for (const sh of sheets) {
      const vp = source.vectorPage(sh.id)
      if (vp) return resolveElement(vp.elements, id)
    }
    return null
  }, [id, source, sheets])
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString()

export function shapes(items: readonly DrawItem[]) {
  let lines = ''
  let maxW = 0
  let fills = ''
  const quads: string[] = []
  const rects: { x: number; y: number; w: number; h: number }[] = []
  for (const it of items) {
    if (it.t === 'path' || it.t === 'segs') {
      maxW = Math.max(maxW, it.w)
      const xy = it.xy
      if (it.t === 'path') {
        for (let k = 0; k + 1 < xy.length; k += 2) lines += `${k ? 'L' : 'M'}${fmt(xy[k])} ${fmt(xy[k + 1])}`
        if (it.closed) lines += 'Z'
      } else for (let k = 0; k + 3 < xy.length; k += 4) lines += `M${fmt(xy[k])} ${fmt(xy[k + 1])}L${fmt(xy[k + 2])} ${fmt(xy[k + 3])}`
    } else if (it.t === 'fill') {
      for (const r of it.rings) {
        for (let k = 0; k + 1 < r.length; k += 2) fills += `${k ? 'L' : 'M'}${fmt(r[k])} ${fmt(r[k + 1])}`
        fills += 'Z'
      }
    } else if (it.t === 'text') {
      const q = textQuad(it, roughMeasure)
      quads.push(Array.from(q, fmt).join(' '))
    } else rects.push(it.rect)
  }
  return { lines, maxW, fills, quads, rects }
}

/** Registered as a sheet overlay: highlights the shown element's items on this sheet. */
export function InspectOverlay({ sheet }: { sheet: Sheet; placement: Placement }) {
  const r = useResolved()
  const f = useFilters()
  const { source } = useDocState()
  const vp = r ? source?.vectorPage?.(sheet.id) : null
  const key = r?.highlight.join(',')
  const sh = useMemo(() => {
    if (!vp || !r) return null
    const hide = hiddenPredicate({ elements: vp.elements }, f)
    const items = itemsOf(vp.page, r.highlight).filter((it) => !hide?.(it))
    return items.length ? { n: items.length, ...shapes(items) } : null
  }, [vp?.page, key, f.version])
  if (!sh || !r) return null
  return (
    <g className="inspect-hl" data-testid="inspect-highlight" data-element={r.highlight[0]} data-items={sh.n}>
      {sh.fills && <path className="fill" d={sh.fills} fillRule="evenodd" />}
      {sh.rects.map((b, i) => (
        <rect key={i} className="box" x={b.x} y={b.y} width={b.w} height={b.h} style={{ strokeWidth: px(1.5) }} />
      ))}
      {sh.quads.map((q, i) => (
        <polygon key={i} className="box" points={q} style={{ strokeWidth: px(1.5) }} />
      ))}
      {sh.lines && (
        <>
          <path className="halo" d={sh.lines} style={{ strokeWidth: `calc(${sh.maxW}px + 8px / var(--z))` }} />
          <path className="line" d={sh.lines} style={{ strokeWidth: `calc(${sh.maxW}px + 1.5px / var(--z))` }} />
        </>
      )}
    </g>
  )
}

interface Appearance {
  sheet: Sheet
  items: number
}

function appearances(r: Resolved): Appearance[] {
  const { source, sheets } = getDocState()
  const out: Appearance[] = []
  for (const s of sheets) {
    const vp = source?.vectorPage?.(s.id)
    if (!vp) continue
    const n = itemsOf(vp.page, r.highlight).length
    if (n) out.push({ sheet: s, items: n })
  }
  return out
}

const sheetName = (s: Sheet) => [s.number, s.name !== s.number ? s.name : ''].filter(Boolean).join(' ') || s.id

/** True while the open document has host elements to inspect. */
export function useCanInspect(): boolean {
  const { source } = useDocState()
  return !!source?.vectorPage
}

/** "-640 Millimeters" -> value and unit, so the unit can be drawn quieter (as Speckle does). */
export function splitUnit(v: string): [string, string] {
  const m = /^(-?[\d.,]+(?:e-?\d+)?)\s+([^\d\s][^\d]*)$/i.exec(v.trim())
  return m ? [m[1], m[2]] : [v, '']
}

function Row({ label, value, raw }: { label: string; value: string; raw?: string }) {
  const [num, unit] = splitUnit(value)
  return (
    <div className="prop-row" role="row">
      <span className="k" role="rowheader" title={raw && raw !== label ? `${label} (${raw})` : label}>
        {label}
      </span>
      <span className="v" role="cell" title={value}>
        {num}
        {unit && <span className="unit"> {unit}</span>}
      </span>
    </div>
  )
}

function Group({ id, title, count, open, onToggle, children }: { id: string; title: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="prop-group" data-group={id} role="rowgroup">
      <button type="button" className="prop-group-head" aria-expanded={open} onClick={onToggle}>
        <ChevronIcon open={open} />
        <span className="t">{title}</span>
        <span className="n">{count}</span>
      </button>
      {open && children}
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
      <path d="M3.5 2 L7 5 L3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The element panel in the left sidebar while the Select tool is on (V3-02/03), a compact property list: the element's
 * name, then collapsible General / Parameters / Sheets groups of label-value rows. Sheets fit the board on a click.
 * Only for a selected (pinned) element: hovering highlights on the sheets but does not open the card, which flickered
 * as the pointer crossed elements. Nothing at all while nothing is selected.
 */
export function ElementPanel() {
  const s = useInspect()
  const r = useResolved(true)
  const { sheets } = useDocState()
  const pinned = s.pinned !== null
  const found = useMemo(() => (r ? appearances(r) : []), [r, sheets])
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const toggle = (g: string) => setClosed((c) => (c.has(g) ? new Set([...c].filter((x) => x !== g)) : new Set([...c, g])))

  if (!r) return null
  const { id, info } = r
  const general: [string, string | null | undefined][] = [
    ['category', info?.category],
    ['class', info?.class],
    ['family', info?.family],
    ['type', info?.type],
    ['name', info?.name],
    ['level', info?.level],
    ['elementId', id],
  ]
  const gen = general.filter((g): g is [string, string] => !!g[1])
  const params = info?.params ?? []
  return (
    <div className={`inspect-panel${pinned ? ' pinned' : ''}`} data-testid="inspect-panel" data-element={id} data-pinned={pinned}>
      <div className="prop-title">
        <div className="titles">
          <span className="name" title={info?.name ?? undefined}>
            {info?.name || `Element ${id}`}
          </span>
          <span className="sub">{(r.tagLabel ? `via ${r.tagLabel.toLowerCase()} · ` : '') + cardCategory(info)}</span>
        </div>
        {pinned ? (
          <button type="button" className="icon-btn" aria-label="Unpin element" title="Unpin (Esc)" onClick={() => inspect.unpin()}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        ) : (
          <span className="state">hover</span>
        )}
      </div>
      <div className="prop-list" role="table" aria-label="Element properties">
        <Group id="general" title="General" count={gen.length} open={!closed.has('general')} onToggle={() => toggle('general')}>
          {gen.map(([k, v]) => (
            <Row key={k} label={k} value={v} />
          ))}
        </Group>
        {params.length > 0 && (
          <Group id="params" title="Parameters" count={params.length} open={!closed.has('params')} onToggle={() => toggle('params')}>
            {params.map((p, i) => (
              <Row key={i} label={paramLabel(p.name)} raw={p.name} value={p.value} />
            ))}
          </Group>
        )}
        <div data-testid="inspect-appears" data-count={found.length}>
          <Group id="sheets" title="On sheets" count={found.length} open={!closed.has('sheets')} onToggle={() => toggle('sheets')}>
            {found.map((a) => (
              <button
                key={a.sheet.id}
                type="button"
                className="prop-row link chip"
                data-sheet-id={a.sheet.id}
                title="Fit this sheet"
                onClick={() => boardView.focusSheet(a.sheet.pageIndex)}
              >
                <span className="k">{sheetName(a.sheet)}</span>
                <span className="v">
                  {a.items}
                  <span className="unit"> {a.items === 1 ? 'item' : 'items'}</span>
                </span>
              </button>
            ))}
          </Group>
        </div>
      </div>
      {!info && <p className="hint">No metadata for this element in the drawing.</p>}
    </div>
  )
}
