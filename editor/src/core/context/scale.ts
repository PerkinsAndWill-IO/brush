import type { RawText } from '../types'

/** Parse a single text for a drawing scale. Returns the ratio denominator (100 for 1:100). */
export function parseScaleText(raw: string): number | undefined {
  const s = raw.trim()
  const ratio = /(?<![\d:.])1\s*:\s*(\d{1,4}(?:\.\d+)?)(?![\d:])/.exec(s)
  if (ratio) {
    const v = parseFloat(ratio[1])
    if (v >= 1 && v <= 5000) return v
  }
  const imp = /((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)\s*(?:"|”|″|'')\s*=\s*(\d+)\s*(?:'|′|ft\b)(?:\s*-?\s*(\d+)\s*(?:"|”|″|'')?)?/i.exec(s)
  if (imp) {
    let inches = 0
    for (const part of imp[1].trim().split(/\s+/)) {
      if (part.includes('/')) {
        const [a, b] = part.split('/').map(Number)
        if (b) inches += a / b
      } else inches += parseFloat(part)
    }
    const feet = parseInt(imp[2], 10) + (imp[3] ? parseInt(imp[3], 10) / 12 : 0)
    if (inches > 0 && feet > 0) {
      const v = (feet * 12) / inches
      if (v >= 1 && v <= 5000) return Math.round(v * 100) / 100
    }
  }
  return undefined
}

/** Pick the sheet scale from all texts, preferring title block / "SCALE" texts. */
export function findScale(texts: RawText[], inTitleBlock: (t: RawText) => boolean): number | undefined {
  const cands: Array<{ v: number; score: number; i: number }> = []
  texts.forEach((t, i) => {
    const v = parseScaleText(t.text)
    if (v === undefined) return
    const score = (inTitleBlock(t) ? 4 : 0) + (/scale/i.test(t.text) ? 2 : 0) + Math.min(t.height, 100) / 1000
    cands.push({ v, score, i })
  })
  if (!cands.length) return undefined
  cands.sort((a, b) => b.score - a.score || a.i - b.i)
  const top = cands[0]
  if (top.score < 2 && cands.some((c) => c.v !== top.v)) return undefined // ambiguous detail scales
  return top.v
}

/** Points per real-world metre at a given scale denominator. */
export function ptPerMetre(scale: number): number {
  return 2834.645669 / scale
}
