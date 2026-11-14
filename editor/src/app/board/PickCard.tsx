/**
 * The element card of the Select tool: category, name, family / type, level, id and the parameters of the element
 * under the pointer (from the document's `elements` table), or of the pinned one. Same content as the schema
 * viewer's card. Hovering shows it beside the pointer; a pin keeps it until Esc or a click on empty paper.
 */
import { memo, useLayoutEffect, useRef } from 'react'
import { categoryOf, paramLabel, resolveElement } from '@core/drawing'
import { drawingPageOf, usePick } from '../drawing/pick'

const OFFSET = 16
const MARGIN = 4

const ElementCard = memo(function ElementCard({ sheetId, el, pinned }: { sheetId: string; el: string; pinned: boolean }) {
  const d = drawingPageOf(sheetId)
  if (!d) return null
  const r = resolveElement(d.doc.elements, el)
  const { info } = r
  const famType = [info?.family, info?.type].filter(Boolean).join(' : ')
  return (
    <>
      <header>
        <div className="cat">{categoryOf(info)}</div>
        <div className="name">{(r.tagLabel ? `${r.tagLabel} → ` : '') + (info?.name || `Element ${r.id}`)}</div>
      </header>
      <div className="meta">
        {famType && (
          <div>
            <span>Family / type: </span>
            {famType}
          </div>
        )}
        {info?.level && (
          <div>
            <span>Level: </span>
            {info.level}
          </div>
        )}
        <div>
          <span>Element id: </span>
          {r.id}
        </div>
      </div>
      {info?.params?.length ? (
        <div className="params">
          <table>
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
        </div>
      ) : (
        !info && <div className="hint">No metadata for this element in the scene.</div>
      )}
      {pinned && <div className="hint">Pinned. Esc or click empty paper to close.</div>}
    </>
  )
})

export function PickCard({ viewport }: { viewport: () => { w: number; h: number } }) {
  const { hover, pinned } = usePick()
  const shown = pinned ?? hover
  const ref = useRef<HTMLDivElement>(null)

  // Beside the pointer, flipped or shifted to stay inside the viewport.
  useLayoutEffect(() => {
    const card = ref.current
    if (!card || !shown) return
    const vp = viewport()
    let x = shown.x + OFFSET
    let y = shown.y + OFFSET
    if (x + card.offsetWidth > vp.w - MARGIN) x = Math.max(MARGIN, shown.x - OFFSET - card.offsetWidth)
    if (y + card.offsetHeight > vp.h - MARGIN) y = Math.max(MARGIN, vp.h - MARGIN - card.offsetHeight)
    card.style.left = `${x}px`
    card.style.top = `${y}px`
  })

  if (!shown) return null
  return (
    <div className={`pick-card${pinned ? ' pinned' : ''}`} ref={ref} data-testid="pick-card" data-element={shown.el} data-pinned={!!pinned}>
      <ElementCard sheetId={shown.sheetId} el={shown.el} pinned={!!pinned} />
    </div>
  )
}
