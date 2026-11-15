/**
 * P1: the photo pipeline end to end in Node (OpenCV WASM), on a synthetic photo with known markup.
 * P1-02 the photo is matched to the sheet; P1-03 pen strokes come back in sheet points, in their ink colour;
 * P1-06 a photo of something else is refused.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { photoToMarkup, probe, type MarkupResult } from '../../../src/app/photo/pipeline'
import { useOpenCv } from './opencv'
import { distanceToPolyline, makeSyntheticCase, type SyntheticCase } from './synthetic'

const TIMEOUT = 120_000
useOpenCv()

describe('photo pipeline on a synthetic photo', () => {
  let c: SyntheticCase
  let result: MarkupResult
  const lines: string[] = []

  beforeAll(async () => {
    c = makeSyntheticCase()
    result = await photoToMarkup(c.photo, c.ref, c.dpi, { log: (l) => lines.push(l) })
  }, TIMEOUT)

  it('P1-02: the quick probe recognises the sheet and estimates how sharp the photo is on it', async () => {
    const p = await probe(c.photo, c.ref, c.dpi)
    expect(p).not.toBeNull()
    expect(p!.tiles).toBeGreaterThanOrEqual(12)
    // the synthetic view shows the sheet at about 0.55 photo px per sheet px
    expect(p!.seenDpi).toBeGreaterThan(c.dpi * 0.45)
    expect(p!.seenDpi).toBeLessThan(c.dpi * 0.65)
  }, TIMEOUT)

  it('P1-02: the probe still recognises the sheet when the app draws it in another style than the print', async () => {
    // another export of the same sheet: every line heavier, rooms filled in colour, the finest linework gone
    const restyled = restyle(c.ref.rgb, c.ref.w, c.ref.h)
    const p = await probe(c.photo, { rgb: restyled, w: c.ref.w, h: c.ref.h }, c.dpi)
    expect(p).not.toBeNull()
    expect(p!.tiles).toBeGreaterThanOrEqual(12)
    expect(p!.seenDpi).toBeGreaterThan(c.dpi * 0.45)
    expect(p!.seenDpi).toBeLessThan(c.dpi * 0.65)
  }, TIMEOUT)

  it('P1-02: registration locks on to within a pixel', () => {
    expect(result.report.featureInliers).toBeGreaterThanOrEqual(12)
    expect(result.report.sheetCoverage).toBeGreaterThan(0.95)
    expect(result.report.offsetFinal, lines.join('\n')).toBeLessThan(1)
  })

  it('P1-03: each pen comes back as its own layer, in its ink colour', () => {
    const names = result.layers.map((l) => l.name)
    expect(names, lines.join('\n')).toContain('red')
    expect(names).toContain('blue')
    const red = result.layers.find((l) => l.name === 'red')!
    const blue = result.layers.find((l) => l.name === 'blue')!
    expect(red.color[0]).toBeGreaterThan(150)
    expect(red.color[2]).toBeLessThan(90)
    expect(blue.color[2]).toBeGreaterThan(140)
    expect(blue.color[0]).toBeLessThan(90)
  })

  it('P1-03: traced strokes follow the drawn markup in sheet points, with the pen width', () => {
    for (const t of c.truth) {
      const layer = result.layers.find((l) => l.name === t.name)!
      const pts = layer.strokes.flatMap((s) => s.points)
      // everything traced lies on the markup…
      const off = pts.filter((p) => distanceToPolyline(p, t.points) > 2.5)
      expect(off.length / pts.length, `${t.name}: traced points off the markup`).toBeLessThan(0.05)
      // …and the markup is traced wherever it runs over blank paper. On top of a line of the drawing the ink
      // cannot be told from the print (a crossing leaves a short gap; running along a line hides the pen), so
      // those stretches are not counted.
      const traced = layer.strokes.map((s) => (s.closed ? [...s.points, s.points[0]] : s.points))
      const s = c.dpi / 72
      const onBlankPaper = ([x, y]: [number, number]) => {
        for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) if (c.ref.rgb[((Math.round(y * s) + j) * c.ref.w + Math.round(x * s) + i) * 3] < 200) return false
        return true
      }
      const samples: [number, number][] = []
      for (let k = 1; k < t.points.length; k++) {
        const [ax, ay] = t.points[k - 1]
        const [bx, by] = t.points[k]
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 2))
        for (let i = 0; i <= n; i++) samples.push([ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n])
      }
      const clear = samples.filter(onBlankPaper)
      expect(clear.length, `${t.name}: the test markup should mostly run over blank paper`).toBeGreaterThan(samples.length * 0.6)
      const gaps = clear.map((q) => Math.min(...traced.map((poly) => distanceToPolyline(q, poly))))
      expect(gaps.filter((d) => d < 3).length / gaps.length, `${t.name}: share of the markup traced`).toBeGreaterThan(0.97)
      expect(Math.max(...gaps), `${t.name}: largest gap`).toBeLessThan(6)
      const widths = layer.strokes.map((s) => s.width).sort((a, b) => a - b)
      expect(widths[widths.length >> 1]).toBeGreaterThan(t.widthPt * 0.5)
      expect(widths[widths.length >> 1]).toBeLessThan(t.widthPt * 1.8)
    }
  })

  it('P1-03: the drawing itself is not mistaken for markup', () => {
    const total = (name: string) =>
      result.layers
        .filter((l) => l.name === name)
        .flatMap((l) => l.strokes)
        .reduce((sum, s) => sum + s.points.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - s.points[i][0], p[1] - s.points[i][1]), 0), 0)
    const truthLength = c.truth.reduce((sum, t) => sum + t.points.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - t.points[i][0], p[1] - t.points[i][1]), 0), 0)
    const extra = result.layers.filter((l) => !c.truth.some((t) => t.name === l.name)).reduce((sum, l) => sum + total(l.name), 0)
    expect(extra, `layers: ${result.layers.map((l) => `${l.name} ${l.strokes.length}`).join(', ')}\n${lines.join('\n')}`).toBeLessThan(truthLength * 0.1)
  })
})

describe('photo pipeline refusals', () => {
  it('P1-06: a photo that does not show the sheet is not registered', async () => {
    const other = makeSyntheticCase({ seed: 99 })
    const blank = makeSyntheticCase({ drawing: false })
    // a different drawing: the probe finds no consistent match, and the full registration refuses
    const p = await probe(other.photo, blank.ref, blank.dpi)
    expect(p).toBeNull()
    await expect(photoToMarkup(other.photo, blank.ref, blank.dpi)).rejects.toThrow(/Could not register the photo/)
  }, TIMEOUT)

  it('P1-02, P1-06: a photo of another drawing (same kind of plan, same title block) is not taken for this sheet', async () => {
    const mine = makeSyntheticCase()
    const other = makeSyntheticCase({ seed: 99 })
    expect(await probe(other.photo, mine.ref, mine.dpi)).toBeNull()
  }, TIMEOUT)
})

/** The same sheet as another export draws it: lines a pixel heavier, rooms tinted, hairlines dropped. */
function restyle(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgb.length)
  const lum = (i: number) => (rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      // heavier: the darkest of the 3x3 neighbourhood
      let m = 255
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m = Math.min(m, lum(Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))))
      // hairlines (light grey after anti-aliasing) are left out
      const v = m < 150 ? m : 255
      // rooms tinted in blocks, like coloured room fills
      const tint = ((x >> 7) + (y >> 7)) % 3 === 0 ? [222, 208, 236] : ((x >> 7) + (y >> 7)) % 3 === 1 ? [214, 232, 206] : [255, 255, 255]
      for (let k = 0; k < 3; k++) out[i * 3 + k] = v === 255 ? tint[k] : v
    }
  return out
}
