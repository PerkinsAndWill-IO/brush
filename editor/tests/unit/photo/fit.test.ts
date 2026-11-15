/**
 * P1: explainAway's two heavy loops (fitting the ink models, explaining every pixel) can run in bands of rows (the
 * photo worker hands the bands to helper workers side by side). In bands they must give exactly what they give in
 * one go.
 */
import { describe, expect, it } from 'vitest'
import { bandRows, explainRows, fitRows, type FitGrid } from '../../../src/app/photo/pipeline/fit'
import { makeSyntheticCase } from './synthetic'

/** Index of the first element where `a` and `b` differ, -1 if none (quicker than toEqual on million-element arrays). */
function firstDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Math.min(a.length, b.length)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i
  return -1
}

describe('photo pipeline: reading the ink in bands of rows', () => {
  it('P1-03: bands of rows give the same models and the same ink as the whole sheet', () => {
    const c = makeSyntheticCase()
    const { w, h } = c.ref
    // the "registered photo": the sheet, a little darker and tinted, a few dark strokes, and an uncovered corner
    const rgb = new Uint8Array(c.ref.rgb.length)
    const valid = new Uint8Array(w * h).fill(1)
    for (let i = 0; i < w * h; i++) {
      for (let k = 0; k < 3; k++) rgb[i * 3 + k] = Math.round(c.ref.rgb[i * 3 + k] * (0.8 + 0.05 * k) + 10)
      const x = i % w, y = (i / w) | 0
      if ((x + 2 * y) % 97 < 3) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 40
      if (x < w * 0.2 && y < h * 0.15) valid[i] = 0
    }
    for (const S of [8, 18]) {
      const half = Math.round(1.5 * S)
      const grid: FitGrid = { w, h, S, half, stride: Math.max(1, Math.floor((2 * half + 1) / 24)), gw: Math.ceil(w / S) + 1, gh: Math.ceil(h / S) + 1 }
      const whole = fitRows(grid, { rgb, valid, refBlur: c.ref.rgb, y0: 0 }, 0, grid.gh)
      expect(whole.ok.some((v) => v)).toBe(true)
      const cuts = [0, 7, Math.floor(grid.gh / 2), grid.gh - 1, grid.gh]
      for (let k = 0; k + 1 < cuts.length; k++) {
        const [gy0, gy1] = [cuts[k], cuts[k + 1]]
        const [y0, y1] = bandRows(grid, gy0, gy1)
        const part = fitRows(grid, { rgb: rgb.slice(y0 * w * 3, y1 * w * 3), valid: valid.slice(y0 * w, y1 * w), refBlur: c.ref.rgb.slice(y0 * w * 3, y1 * w * 3), y0 }, gy0, gy1)
        const g0 = gy0 * grid.gw, g1 = gy1 * grid.gw
        expect(firstDiff(part.A, whole.A.subarray(g0 * 3, g1 * 3)), 'A').toBe(-1)
        expect(firstDiff(part.B, whole.B.subarray(g0 * 3, g1 * 3)), 'B').toBe(-1)
        expect(firstDiff(part.ok, whole.ok.subarray(g0, g1)), 'ok').toBe(-1)
        expect(firstDiff(part.seesPaper, whole.seesPaper.subarray(g0, g1)), 'seesPaper').toBe(-1)
      }
      // every pixel against the models, in one go and in bands of rows (refBlur standing in for refLo)
      const edgeNode = new Uint8Array(grid.gw * grid.gh).map((_, i) => (i % 7 === 0 ? 1 : 0))
      const params = { w, h, S, gw: grid.gw, gh: grid.gh, A: whole.A, B: whole.B, edgeNode }
      const all = explainRows(params, { rgb, valid, refLo: c.ref.rgb, y0: 0, y1: h })
      expect(all.absorb.some((v) => v > 50)).toBe(true)
      for (const [y0, y1] of [[0, 5], [5, Math.floor(h / 2)], [Math.floor(h / 2), h]]) {
        const part = explainRows(params, { rgb: rgb.slice(y0 * w * 3, y1 * w * 3), valid: valid.slice(y0 * w, y1 * w), refLo: c.ref.rgb.slice(y0 * w * 3, y1 * w * 3), y0, y1 })
        for (const k of ['absorb', 'flat', 'foreign', 'edgeZone'] as const) expect(firstDiff(part[k]!, all[k]!.subarray(y0 * w, y1 * w)), k).toBe(-1)
        for (const k of ['inkRgb', 'clean'] as const) expect(firstDiff(part[k], all[k].subarray(y0 * w * 3, y1 * w * 3)), k).toBe(-1)
      }
    }
  }, 60_000)
})
