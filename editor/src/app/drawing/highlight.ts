/**
 * Draws the picked element's items in the accent colour on the pick layer of a sheet (canvas, sheet points). The
 * page raster underneath is not touched, so a hover never re-renders the sheet.
 */
import { boxCorners, type DrawItem, type HitIndex } from '@core/drawing'
import { drawText } from './render'

const paths = new WeakMap<DrawItem, Path2D>()

function pathOf(it: DrawItem): Path2D {
  let p = paths.get(it)
  if (p) return p
  p = new Path2D()
  if (it.t === 'path') {
    const xy = it.xy
    if (xy.length >= 4) {
      p.moveTo(xy[0], xy[1])
      for (let k = 2; k < xy.length; k += 2) p.lineTo(xy[k], xy[k + 1])
      if (it.closed) p.closePath()
    }
  } else if (it.t === 'segs') {
    for (let k = 0; k + 3 < it.xy.length; k += 4) {
      p.moveTo(it.xy[k], it.xy[k + 1])
      p.lineTo(it.xy[k + 2], it.xy[k + 3])
    }
  } else if (it.t === 'fill') {
    for (const r of it.rings) {
      if (r.length < 4) continue
      p.moveTo(r[0], r[1])
      for (let k = 2; k < r.length; k += 2) p.lineTo(r[k], r[k + 1])
      p.closePath()
    }
  }
  paths.set(it, p)
  return p
}

/**
 * Paint `itemIdx` of the page into `g`, already scaled to sheet points. `z` is the board zoom: line widths and
 * outlines are given in screen pixels, like the schema viewer's.
 */
export function paintHighlight(g: CanvasRenderingContext2D, index: HitIndex, itemIdx: readonly number[], z: number, accent: string) {
  const px = 1 / z // one screen pixel in sheet points
  g.lineJoin = 'round'
  g.strokeStyle = accent
  g.fillStyle = accent
  for (const i of itemIdx) {
    const it = index.page.items[i]
    if (it.t === 'path' || it.t === 'segs') {
      g.lineWidth = Math.max(it.w * 1.5, 3 * px)
      g.stroke(pathOf(it))
    } else if (it.t === 'fill') {
      g.globalAlpha = 0.45
      g.fill(pathOf(it), 'evenodd')
      g.globalAlpha = 1
      g.lineWidth = 2 * px
      g.stroke(pathOf(it))
    } else if (it.t === 'text') {
      const c = boxCorners(index.layouts[i]!)
      g.beginPath()
      g.moveTo(c[0], c[1])
      for (let k = 2; k < 8; k += 2) g.lineTo(c[k], c[k + 1])
      g.closePath()
      g.globalAlpha = 0.25
      g.fill()
      g.globalAlpha = 1
      g.lineWidth = 1.5 * px
      g.stroke()
      drawText(g, it, px, accent)
    } else {
      g.lineWidth = 3 * px
      g.strokeRect(it.rect.x, it.rect.y, it.rect.w, it.rect.h)
    }
  }
}
