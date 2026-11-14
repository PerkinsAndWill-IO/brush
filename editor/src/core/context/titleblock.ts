import type { RawPageContent, RawText, Rect } from '../types'
import type { PathInfo } from './internal/shapes'
import { classifyPath } from './internal/shapes'
import { findScale } from './scale'
import { DRAWING_CODE_RE, SHEET_NUMBER_RE, normalizeDrawingCode } from './text'

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
    const num = raw.texts.find((t) => (SHEET_NUMBER_RE.test(t.text.trim()) || DRAWING_CODE_RE.test(t.text.trim())) && t.x > 0.6 * W && t.y > 0.6 * H)
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

const DATE_RE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/

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
  // A structured drawing code (ISO 19650 style "KRO-APD-ARC-PLN-A1A-N01-0001 - 007") beats a short sheet number.
  const codes = pool
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => DRAWING_CODE_RE.test(t.text.trim()))
    .sort((a, b) => b.t.height - a.t.height || a.i - b.i)
  const codeText = codes[0]?.t
  if (codeText) {
    out.number = normalizeDrawingCode(codeText.text)
    const name = titleNear(pool, codeText, W)
    if (name) out.name = name
  } else {
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
  }
  const sc = findScale(raw.texts, inTB)
  if (sc !== undefined) out.scale = sc
  return out
}

/**
 * Title of a sheet with a drawing code: the largest-font text lines near the code (title blocks print the title
 * 1.5-3x larger than field labels), top to bottom, joined with " · ". Dates, revision indices and labels are skipped.
 */
function titleNear(pool: RawText[], code: RawText, W: number): string | undefined {
  const near = pool.filter((t) => {
    if (t === code) return false
    const s = t.text.trim()
    if (s.replace(/[^A-Za-zÀ-ÿ]/g, '').length < 3 || DATE_RE.test(s) || /[:/\\]$|:\s|:\/\//.test(s)) return false
    return Math.abs(t.x - code.x) <= 0.15 * W && Math.abs(t.y - code.y) <= 0.06 * W
  })
  if (!near.length) return undefined
  const maxH = Math.max(...near.map((t) => t.height))
  if (maxH < 1.2 * code.height) return undefined
  const big = near.filter((t) => t.height >= 0.85 * maxH).sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: string[] = []
  for (const t of big) {
    const s = t.text.trim().replace(/\s+/g, ' ')
    if (!lines.includes(s)) lines.push(s)
  }
  return lines.slice(0, 4).join(' · ') || undefined
}

export type SheetType = 'plan' | 'elevation' | 'section' | 'axonometric' | 'detail' | 'other' | 'unknown'

export interface SheetClass {
  sheetType: SheetType
  /** 0..1 */
  confidence: number
  /** What decided it: 'code' (discipline/type field of the drawing number), 'title' (title words), or 'none'. */
  by: 'code' | 'title' | 'none'
}

/** Type fields of drawing codes (ISO 19650 / national variants). */
const CODE_TYPES: Array<[RegExp, SheetType]> = [
  [/^(?:PLN|PLA|PLAN)$/, 'plan'],
  [/^(?:ELE|ELV|FAC|OPS)$/, 'elevation'],
  [/^(?:SEC|SCT|SNT|COU|CPE)$/, 'section'],
  [/^(?:SYN|AXO|ISO|PER|3D|PSP)$/, 'axonometric'],
  [/^(?:DET|DTL)$/, 'detail'],
  [/^(?:SCH|SHD|LST|COV)$/, 'other'],
]

/** Title words (EN, FR, DA/NO/SV, DE, NL, ES/IT). Order matters: earlier entries win ties. */
const TITLE_TYPES: Array<[RegExp, SheetType]> = [
  [/AXONOM|ISOM[EÉ]TR|PERSPE[CK]TIV|VOLUM[EÉ]TRI|\b3D\b|RENDER/i, 'axonometric'],
  [/\bSECTION|\bCOUPE|\bSNIT|SCHNITT|\bSEKTION|DOORSNEDE|\bSECCI[OÓ]N|\bSEZIONE/i, 'section'],
  [/[EÉ]L[EÉ]VATION|FA[CÇ]ADE|OPSTALT|FASADE|ANSICHT|AANZICHT|ALZADO|PROSPETTO/i, 'elevation'],
  [/\bDETAIL|\bD[EÉ]TAIL/i, 'detail'],
  [/\bPLAN\b|\bPLANS\b|PLANTEGNING|GRUNDRISS|PLATTEGROND|\bPLANTA\b|\bPIANTA\b|FLOOR|ETAGE|\bNIVEAU\b|\bLEVEL\b/i, 'plan'],
  [/SCHEDULE|LEGEND|COVER|INDEX|NOTES|NOMENCLATURE|L[EÉ]GENDE/i, 'other'],
]

/**
 * Sheet type from the title block: the drawing code's type field first (e.g. "KRO-APD-ARC-PLN-..." -> plan,
 * "-ELE-" -> elevation, "-SYN-" -> axonometric), then title words. 'unknown' when nothing says.
 * Callers treat only 'plan' and 'unknown' as sheets where plan geometry (walls, doors, fixtures, rooms) makes sense.
 */
export function classifySheet(info: TitleBlockInfo): SheetClass {
  if (info.number && DRAWING_CODE_RE.test(info.number)) {
    const fields = info.number.toUpperCase().split(/[-_.\s]+/)
    // the type field follows project / originator / discipline; skip the first field (project code)
    for (const f of fields.slice(1)) for (const [re, t] of CODE_TYPES) if (re.test(f)) return { sheetType: t, confidence: 0.9, by: 'code' }
  }
  if (info.name) {
    for (const [re, t] of TITLE_TYPES) if (re.test(info.name)) return { sheetType: t, confidence: 0.75, by: 'title' }
  }
  return { sheetType: 'unknown', confidence: 0, by: 'none' }
}

/** Plan-geometry items (walls, openings, fixtures, rooms) are emitted only on these sheet types. */
export function allowsPlanGeometry(t: SheetType): boolean {
  return t === 'plan' || t === 'unknown'
}
