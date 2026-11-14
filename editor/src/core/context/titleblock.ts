import type { RawPageContent, RawText, Rect } from '../types'
import type { PathInfo } from './internal/shapes'
import { classifyPath } from './internal/shapes'
import { findScale } from './scale'
import { SHEET_NUMBER_RE } from './text'

export interface Frame {
  border?: Rect
  blocks: Rect[]
  /** Point lies in the title block / margin area (outside the drawing border). */
  inTitleBlock(x: number, y: number): boolean
}

const M = 2.5

function inRect(r: Rect, x: number, y: number, pad: number): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad
}

export function detectFrame(raw: RawPageContent, infos?: PathInfo[]): Frame {
  const W = raw.sizePt.w
  const H = raw.sizePt.h
  const rects: Rect[] = []
  const inf = infos ?? raw.paths.map(classifyPath)
  for (const i of inf) {
    if (i.kind === 'rect' && i.axisAligned) {
      rects.push({ x: i.bbox.minX, y: i.bbox.minY, w: i.bbox.maxX - i.bbox.minX, h: i.bbox.maxY - i.bbox.minY })
    }
  }
  // border: smallest rect covering >=85% of both dims, within ~8% of every edge
  let border: Rect | undefined
  for (const r of rects) {
    if (r.w >= 0.85 * W && r.h >= 0.85 * H && r.x <= 0.08 * W && r.y <= 0.08 * H && r.x + r.w >= 0.92 * W && r.y + r.h >= 0.92 * H) {
      if (!border || r.w * r.h < border.w * border.h) border = r
    }
  }
  const edgeR = border ? border.x + border.w : W
  const edgeB = border ? border.y + border.h : H
  const blocks: Rect[] = []
  for (const r of rects) {
    if (r === border) continue
    if (r.w < 60 || r.h < 30 || r.w * r.h > 0.3 * W * H) continue
    if (border && !(r.x >= border.x - 3 && r.y >= border.y - 3 && r.x + r.w <= edgeR + 3 && r.y + r.h <= edgeB + 3)) continue
    if (Math.abs(r.x + r.w - edgeR) <= 6 || Math.abs(r.y + r.h - edgeB) <= 6) blocks.push(r)
  }
  if (!blocks.length) {
    // fall back: cluster of texts around a sheet number in the bottom-right
    const num = raw.texts.find((t) => SHEET_NUMBER_RE.test(t.text.trim()) && t.x > 0.6 * W && t.y > 0.6 * H)
    if (num) {
      const near = raw.texts.filter((t) => Math.abs(t.x - num.x) <= 0.2 * W && Math.abs(t.y - num.y) <= 0.15 * H && t.x > 0.5 * W && t.y > 0.5 * H)
      let x0 = Infinity
      let y0 = Infinity
      for (const t of near) {
        x0 = Math.min(x0, t.x)
        y0 = Math.min(y0, t.y - t.height)
      }
      x0 -= 10
      y0 -= 10
      blocks.push({ x: x0, y: y0, w: W - x0, h: H - y0 })
    }
  }
  const frame: Frame = {
    border,
    blocks,
    inTitleBlock(x, y) {
      if (border && !inRect(border, x, y, -M)) return true
      for (const b of blocks) if (inRect(b, x, y, M)) return true
      return false
    },
  }
  return frame
}

export function textCenter(t: RawText): { x: number; y: number } {
  return { x: t.x + t.width / 2, y: t.y - t.height / 2 }
}

export interface TitleBlockInfo {
  number?: string
  name?: string
  scale?: number
}

const NAME_HINT = /PLAN|ELEVATION|SECTION|DETAIL|SCHEDULE|LEGEND|DIAGRAM|SITE|ROOF|FLOOR|COVER|INDEX/i
const BOILER = /^(project|date|drawn|checked|scale|sheet|revision|rev|title|issue|client|approved|no\.?|number|by|north|job)\b/i

export function parseTitleBlock(raw: RawPageContent, frame?: Frame): TitleBlockInfo {
  const f = frame ?? detectFrame(raw)
  const W = raw.sizePt.w
  const H = raw.sizePt.h
  const inTB = (t: RawText) => {
    const c = textCenter(t)
    return f.inTitleBlock(c.x, c.y)
  }
  let pool = raw.texts.filter(inTB)
  if (!pool.length) pool = raw.texts.filter((t) => t.x > 0.55 * W && t.y > 0.55 * H)
  const out: TitleBlockInfo = {}
  const nums = pool
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => SHEET_NUMBER_RE.test(t.text.trim()))
    .sort((a, b) => b.t.height - a.t.height || a.i - b.i)
  const numText = nums[0]?.t
  if (numText) out.number = numText.text.trim()
  const names = pool
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      const s = t.text.trim()
      return t !== numText && s.replace(/[^A-Za-z]/g, '').length >= 4 && !BOILER.test(s) && !/\d\s*:\s*\d/.test(s)
    })
    .sort((a, b) => Number(NAME_HINT.test(b.t.text)) - Number(NAME_HINT.test(a.t.text)) || b.t.height - a.t.height || a.i - b.i)
  if (names[0]) out.name = names[0].t.text.trim()
  const sc = findScale(raw.texts, inTB)
  if (sc !== undefined) out.scale = sc
  return out
}
