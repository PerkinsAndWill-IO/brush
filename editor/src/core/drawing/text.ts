/**
 * Text boxes of `.drawing` text items, in sheet points (y down). Shared by the page renderer (wrapping) and the
 * hit index (the box a pointer can pick). No DOM: the caller injects a width measurer.
 */
import type { DrawText } from './format'

/** Width in points of `text` set at an em size of `em` points. */
export type Measure = (text: string, em: number, bold: boolean) => number

/** Arial cap height in em, and line height (as in the schema viewer's text layout). */
export const CAP_EM = 0.716
export const LINE_EM = 1.2

/** Break `text` at newlines, then greedily at spaces so no line exceeds `maxWidth` (null = no wrapping). */
export function wrapLines(text: string, maxWidth: number | null, width: (line: string) => number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (maxWidth === null) {
      out.push(para)
      continue
    }
    let line = ''
    for (const word of para.split(' ')) {
      const cand = line === '' ? word : `${line} ${word}`
      if (line !== '' && width(cand) > maxWidth) {
        out.push(line)
        line = word
      } else line = cand
    }
    out.push(line)
  }
  return out
}

export interface TextLayout {
  lines: string[]
  /** Em size in points. */
  em: number
  lineHeight: number
  width: number
  height: number
  /** Unit baseline direction, and the unit vector across it pointing down the page (sheet space, y down). */
  dir: { x: number; y: number }
  perp: { x: number; y: number }
  /** The anchor point, and where the box starts along `dir` and across it (both <= 0), in points. */
  at: { x: number; y: number }
  u0: number
  v0: number
}

export function layoutText(t: DrawText, measure: Measure): TextLayout {
  const em = t.size / CAP_EM
  const lines = wrapLines(t.text, t.maxWidth, (s) => measure(s, em, t.bold))
  const width = Math.max(0, ...lines.map((l) => measure(l, em, t.bold)))
  const lineHeight = em * LINE_EM
  const height = lines.length * lineHeight
  const fx = t.anchor[0] === 'l' ? 0 : t.anchor[0] === 'r' ? 1 : 0.5
  const fy = t.anchor[1] === 't' ? 0 : t.anchor[1] === 'b' ? 1 : 0.5
  return { lines, em, lineHeight, width, height, dir: t.dir, perp: { x: -t.dir.y, y: t.dir.x }, at: t.at, u0: -width * fx, v0: -height * fy }
}

/** Corners of the box in sheet points, clockwise on the page from the top-left: x0,y0,...,x3,y3. */
export function boxCorners(l: TextLayout): number[] {
  const out: number[] = []
  for (const [u, v] of [[l.u0, l.v0], [l.u0 + l.width, l.v0], [l.u0 + l.width, l.v0 + l.height], [l.u0, l.v0 + l.height]]) {
    out.push(l.at.x + u * l.dir.x + v * l.perp.x, l.at.y + u * l.dir.y + v * l.perp.y)
  }
  return out
}

export function pointInTextBox(l: TextLayout, px: number, py: number, pad = 0): boolean {
  const dx = px - l.at.x
  const dy = py - l.at.y
  const u = dx * l.dir.x + dy * l.dir.y
  const v = dx * l.perp.x + dy * l.perp.y
  return u >= l.u0 - pad && u <= l.u0 + l.width + pad && v >= l.v0 - pad && v <= l.v0 + l.height + pad
}
