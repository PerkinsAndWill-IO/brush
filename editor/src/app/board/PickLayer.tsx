/**
 * Pick layer of a sheet (Select tool): a canvas over the paper where the hovered or pinned element's items are
 * drawn in the accent colour. It redraws on its own when the pick changes, so the sheet itself never re-renders.
 * The backing store is only allocated while an element is shown on this sheet and freed when the Select tool is left.
 */
import { memo, useEffect, useRef } from 'react'
import type { Sheet } from '@core/types'
import { getCamera, onCameraSettled } from '../camera'
import { paintHighlight } from '../drawing/highlight'
import { activePick, hitIndexOf, itemsOfElement, subscribePick } from '../drawing/pick'
import { getSession, subscribeSession } from '../session'

export const PickLayer = memo(function PickLayer({ sheet, scale }: { sheet: Sheet; scale: number }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = ref.current
    if (!c || scale === 0) return
    let drawn = ''
    const accent = getComputedStyle(c).getPropertyValue('--accent').trim() || '#1e55d9'
    const sync = (force = false) => {
      const a = activePick()
      const el = a && a.sheetId === sheet.id ? a.el : null
      const key = el === null ? '' : `${el}@${scale}`
      // keep the allocation while the tool is active (hover moves between elements); free it otherwise
      const release = el === null && getSession().tool !== 'select' && c.width > 0
      if (key === drawn && !force && !release) return
      drawn = key
      if (el === null) {
        if (release) c.width = c.height = 0
        else c.getContext('2d')?.clearRect(0, 0, c.width, c.height)
        return
      }
      const index = hitIndexOf(sheet.id)
      const g = c.getContext('2d')
      if (!index || !g) return
      const w = Math.max(1, Math.floor(sheet.sizePt.w * scale))
      const h = Math.max(1, Math.floor(sheet.sizePt.h * scale))
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      } else {
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.clearRect(0, 0, w, h)
      }
      g.setTransform(scale, 0, 0, scale, 0, 0)
      paintHighlight(g, index, itemsOfElement(sheet.id, el), getCamera().z, accent)
    }
    // painting waits for the next frame, so the pointer handler only records what is under the pointer
    let raf = 0
    let forced = false
    const later = (force = false) => {
      forced ||= force
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          const f = forced
          forced = false
          sync(f)
        })
    }
    sync(true)
    const offs = [subscribePick(() => later()), subscribeSession(() => later()), onCameraSettled(() => later(true))]
    return () => {
      offs.forEach((off) => off())
      if (raf) cancelAnimationFrame(raf)
    }
  }, [sheet, scale])

  return <canvas className="pick-canvas" ref={ref} data-layer="pick" />
})
