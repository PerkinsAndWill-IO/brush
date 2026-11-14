import type { RawText } from '../types'

/** A scale label word: English, French, Danish/Norwegian, German, Swedish, Dutch, Spanish/Italian. */
export const SCALE_WORD = /(?<![A-Za-z])(?:scale|[ÉéEe]chelle|m[åÅa]a?lestok|ma(?:ß|ss)stab|skala|schaal|escala|scala)(?![a-z])/i

/**
 * Parse a single text for a drawing scale. Returns the ratio denominator (100 for 1:100).
 * A ratio followed by a word is not a scale ("1:1 landskab ApS" is a company name), except a paper-size suffix
 * ("1:100 @ A1", "1:50 (A3)"). "1:1" (full size) counts only with a scale word in the same text.
 */
export function parseScaleText(raw: string): number | undefined {
  const s = raw.trim()
  const ratio = /(?<![\d:.])1\s*:\s*(\d{1,4}(?:[.,]\d+)?)(?![\d:])/.exec(s)
  if (ratio) {
    const rest = s.slice(ratio.index + ratio[0].length).trim()
    const wordAfter = /^[A-Za-zÀ-ÿ]{2,}/.exec(rest)
    const paperSuffix = /^(?:@|(?:at|på|ved|sur)\s|[([]|A[0-4]\b|$)/i.test(rest)
    const v = parseFloat(ratio[1].replace(',', '.'))
    const ok = v >= 1 && v <= 5000 && (paperSuffix || !wordAfter) && (v !== 1 || SCALE_WORD.test(s))
    if (ok) return v
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

/** True if a scale label ("Échelle :", "SCALE", "Målestok") sits just left of or above `t`. */
function labelledScale(t: RawText, labels: RawText[]): boolean {
  for (const l of labels) {
    if (l === t) continue
    const h = Math.max(t.height, l.height)
    const sameRow = Math.abs(l.y - t.y) <= 0.6 * h && l.x < t.x && t.x - (l.x + l.width) <= 25 * h
    const above = t.y - l.y > 0 && t.y - l.y <= 3 * h && Math.abs(l.x - t.x) <= 10 * h
    if (sameRow || above) return true
  }
  return false
}

/** Pick the sheet scale from all texts, preferring title block / "SCALE" texts. */
export function findScale(texts: RawText[], inTitleBlock: (t: RawText) => boolean): number | undefined {
  const cands: Array<{ v: number; score: number; i: number }> = []
  const labels = texts.filter((t) => SCALE_WORD.test(t.text) && t.text.trim().length <= 24)
  texts.forEach((t, i) => {
    const v = parseScaleText(t.text)
    if (v === undefined) return
    const named = SCALE_WORD.test(t.text) || labelledScale(t, labels)
    const score = (inTitleBlock(t) ? 4 : 0) + (named ? 2 : 0) + Math.min(t.height, 100) / 1000
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
