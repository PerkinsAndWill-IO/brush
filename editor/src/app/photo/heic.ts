/**
 * HEIC / HEIF photos (iPhone's default format) for browsers that cannot decode them (all but Safari): libheif
 * compiled to WebAssembly (libheif-js, decision 0010), loaded only when such a photo comes in. Runs in the photo
 * worker. libheif applies the file's rotation and mirroring, so the image comes out upright.
 */

/** HEIF brands (ISO BMFF `ftyp`) of still images coded with HEVC, the ones libheif-js can decode. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'])

/** Is this the start of a HEIF file (an `ftyp` box naming a HEVC still-image brand)? */
export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12) return false
  const ascii = (a: number, b: number) => String.fromCharCode(...head.subarray(a, b))
  if (ascii(4, 8) !== 'ftyp') return false
  if (HEIF_BRANDS.has(ascii(8, 12))) return true
  // compatible brands follow the major brand and its version
  const size = Math.min(head.length, (head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3])
  for (let i = 16; i + 4 <= size; i += 4) if (HEIF_BRANDS.has(ascii(i, i + 4))) return true
  return false
}

export interface DecodedImage {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

/** Decode the primary image of a HEIF file to RGBA. */
export async function decodeHeif(bytes: Uint8Array): Promise<DecodedImage> {
  const { default: factory } = await import('libheif-js/libheif-wasm/libheif-bundle.mjs')
  const lib = await factory()
  const images = new lib.HeifDecoder().decode(bytes)
  try {
    const image = images.find((i) => i.is_primary()) ?? images[0]
    if (!image) throw new Error('the HEIC file holds no image')
    const width = image.get_width()
    const height = image.get_height()
    const out: DecodedImage = { data: new Uint8ClampedArray(width * height * 4), width, height }
    await new Promise<void>((resolve, reject) => image.display(out, (d) => (d ? resolve() : reject(new Error('could not decode the HEIC photo')))))
    return out
  } finally {
    for (const i of images) i.free()
  }
}
