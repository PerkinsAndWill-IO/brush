/**
 * P1-10: HEIC photos (iPhone's format) are read in every browser, not only Safari: app/photo/heic.ts, libheif-js
 * (decision 0010). The fixture is a 320x240 test card made with the Windows HEIF encoder.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeHeif, isHeif } from '../../../src/app/photo/heic'

const CARD = new Uint8Array(readFileSync(new URL('../../../fixtures/photos/test-card.heic', import.meta.url)))
const box = (major: string, compatible: string[]) => {
  const bytes = [0, 0, 0, 16 + 4 * compatible.length, ...'ftyp'.split('').map((c) => c.charCodeAt(0)), ...major.split('').map((c) => c.charCodeAt(0)), 0, 0, 0, 0]
  for (const b of compatible) bytes.push(...b.split('').map((c) => c.charCodeAt(0)))
  return new Uint8Array(bytes)
}

describe('P1-10 HEIC photos', () => {
  it('P1-10: tells a HEIC file by its ftyp brand, also when HEIC is only a compatible brand', () => {
    expect(isHeif(CARD.subarray(0, 64))).toBe(true)
    expect(isHeif(box('heix', []))).toBe(true)
    expect(isHeif(box('isom', ['mif1', 'heic']))).toBe(true)
    // not HEIC: a JPEG, an MP4, AVIF (the browser reads it itself), too short
    expect(isHeif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]))).toBe(false)
    expect(isHeif(box('isom', ['iso2', 'mp41']))).toBe(false)
    expect(isHeif(box('avif', ['avif']))).toBe(false)
    expect(isHeif(new Uint8Array(8))).toBe(false)
  })

  it('P1-10: decodes the photo upright, in its colours', async () => {
    const img = await decodeHeif(CARD)
    expect([img.width, img.height]).toEqual([320, 240])
    expect(img.data).toHaveLength(320 * 240 * 4)
    const at = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3))
    const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]) < 40)
    expect(near(at(160, 8), [0, 0, 0])).toBe(true) // the black bar is at the top
    expect(near(at(80, 150), [220, 40, 40])).toBe(true) // red on the left
    expect(near(at(240, 150), [30, 60, 220])).toBe(true) // blue on the right
  }, 60_000)

  it('P1-10: a file that is not HEIC is refused, not decoded into garbage', async () => {
    await expect(decodeHeif(new Uint8Array(200))).rejects.toThrow()
  }, 60_000)
})
