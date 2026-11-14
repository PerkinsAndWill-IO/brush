/**
 * Inspect UI (docs/tasks/V3-inspect.md):
 *  - InspectOverlay (V3-01): on every sheet, the items of the hovered or pinned element (and the element a tag
 *    labels), drawn over the page in sheet points
 *  - ElementPanel  (V3-02/03): the element's metadata in the Select tool's sidebar panel; pinned by a click, with the sheets the
 *    element appears on (a click on one fits that sheet)
 */
import { useMemo } from 'react'
import type { Sheet } from '@core/types'
import type { DrawItem } from '@core/drawing'
import type { Placement } from '../board/layout'
import { boardView } from '../board/Board'
import { getDocState, useDocState } from '../store'
import { hiddenPredicate, useFilters } from './filters'
import { roughMeasure, textQuad } from './hit'
import { cardCategory, inspect, itemsOf, paramLabel, resolveElement, shownElement, useInspect, type Resolved } from './inspect'

const px = (n: number) => `calc(${n}px / var(--z))`

/** Highlight ids for the element on show, resolved against the elements of the open document. */
function useResolved(): Resolved | null {
  const s = useInspect()
  const { source, sheets } = useDocState()
  const id = shownElement(s)
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

function shapes(items: readonly DrawItem[]) {
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

/**
 * The element panel in the left sidebar while the Select tool is on (V3-02/03): the hovered or pinned element's data and the sheets it is
 * drawn on (a click fits that sheet). Empty state explains how to pick one.
 */
export function ElementPanel() {
  const s = useInspect()
  const r = useResolved()
  const { sheets } = useDocState()
  const pinned = s.pinned !== null
  const found = useMemo(() => (r ? appearances(r) : []), [r, sheets])

  if (!r)
    return (
      <div className="inspect-panel" data-testid="inspect-panel" data-element="">
        <p className="hint">Hover an element on a sheet to see its data here and highlight it on every sheet it appears on. Click to pin it, Esc releases. Drag pans.</p>
      </div>
    )
  const { id, info } = r
  const famType = [info?.family, info?.type].filter(Boolean).join(' : ')
  const meta: [string, string | null | undefined][] = [
    ['Family / type', famType],
    ['Level', info?.level],
    ['Element id', id],
  ]
  return (
    <div className={`inspect-panel${pinned ? ' pinned' : ''}`} data-testid="inspect-panel" data-element={id} data-pinned={pinned}>
      <div className="el-head">
        <div>
          <div className="cat">{cardCategory(info)}</div>
          <div className="name">{(r.tagLabel ? `${r.tagLabel} → ` : '') + (info?.name || `Element ${id}`)}</div>
        </div>
        {pinned && (
          <button type="button" className="close" aria-label="Unpin element" title="Unpin (Esc)" onClick={() => inspect.unpin()}>
            ×
          </button>
        )}
      </div>
      <dl className="meta">
        {meta
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      <div className="appears" data-testid="inspect-appears" data-count={found.length}>
        <div className="label">
          On {found.length} {found.length === 1 ? 'sheet' : 'sheets'}
        </div>
        <div className="chips">
          {found.map((a) => (
            <button
              key={a.sheet.id}
              type="button"
              className="chip"
              data-sheet-id={a.sheet.id}
              title={`${a.items} ${a.items === 1 ? 'item' : 'items'} · fit this sheet`}
              onClick={() => boardView.focusSheet(a.sheet.pageIndex)}
            >
              {sheetName(a.sheet)}
            </button>
          ))}
        </div>
      </div>
      {info?.params?.length ? (
        <table className="params">
          <tbody>
            {info.params.map((p, i) => {
              const nice = paramLabel(p.name)
              return (
                <tr key={i}>
                  <td>
                    {nice}
                    {nice !== p.name && <div className="raw">{p.name}</div>}
                  </td>
                  <td>{p.value}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : !info ? (
        <p className="hint">No metadata for this element in the drawing.</p>
      ) : null}
      <p className="hint">{pinned ? 'Pinned. Esc or click empty paper to release.' : 'Click to pin.'}</p>
    </div>
  )
}
