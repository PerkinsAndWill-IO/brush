import type { RawPageContent, RawPath, RawText } from '../../../src/core/types'

export function page(paths: RawPath[] = [], texts: RawText[] = [], w = 842, h = 595): RawPageContent {
  return { sheetId: 's1', sizePt: { w, h }, paths, texts }
}

export function line(x1: number, y1: number, x2: number, y2: number, lineWidth = 0.5, dash?: number[]): RawPath {
  return { points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false, lineWidth, dash, stroked: true, filled: false }
}

export function rect(x: number, y: number, w: number, h: number, o: Partial<RawPath> = {}): RawPath {
  return {
    points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
    closed: true,
    lineWidth: 0.5,
    stroked: true,
    filled: false,
    ...o,
  }
}

export function circle(cx: number, cy: number, r: number, n = 24): RawPath {
  const points = []
  for (let i = 0; i < n; i++) points.push({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) })
  return { points, closed: true, lineWidth: 0.5, stroked: true, filled: false }
}

/** Arc around (cx,cy) from angle a0 to a1 (radians), flattened. */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 12): RawPath {
  const points = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { points, closed: false, lineWidth: 0.5, stroked: true, filled: false }
}

export function text(s: string, x: number, y: number, height = 8, width?: number): RawText {
  return { text: s, x, y, width: width ?? s.length * height * 0.6, height }
}
