/**
 * Photo worker: decodes the photo and runs the markup pipeline (OpenCV WASM) off the main thread.
 * One worker per import; the client terminates it afterwards, which frees the WASM heap.
 */
import './pipeline/cv-browser'
import { photoToMarkup, probe, type RgbImage } from './pipeline'
import { rgbaToRgb } from './pipeline/raster'
import type { PhotoRequest, PhotoResponse, RasterMessage } from './protocol'

const scope = self as unknown as {
  postMessage(message: PhotoResponse): void
  onmessage: ((e: MessageEvent<PhotoRequest>) => void) | null
}

/** Photos larger than this on the long side are scaled down while decoding (memory; no sheet needs more). */
const MAX_PHOTO_SIDE = 6000

let photo: RgbImage | null = null

const post = (msg: PhotoResponse) => scope.postMessage(msg)
const toRgb = (r: RasterMessage): RgbImage => ({ rgb: rgbaToRgb(new Uint8ClampedArray(r.rgba), r.w, r.h), w: r.w, h: r.h })

async function decode(blob: Blob): Promise<RgbImage> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This browser cannot read that image. Use a JPEG or PNG (iPhone HEIC photos: export or share them as JPEG).')
  }
  const k = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d', { willReadFrequently: true })
  if (!g) throw new Error('could not decode the photo (no 2D context)')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, w, h)
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const img = g.getImageData(0, 0, w, h)
  return { rgb: rgbaToRgb(img.data, w, h), w, h }
}

scope.onmessage = async (e) => {
  const req = e.data
  const log = (line: string) => post({ id: req.id, type: 'log', line })
  try {
    if (req.type === 'decode') {
      photo = await decode(req.blob)
      post({ id: req.id, ok: true, type: 'decode', w: photo.w, h: photo.h })
      return
    }
    if (!photo) throw new Error('no photo decoded yet')
    if (req.type === 'probe') {
      post({ id: req.id, ok: true, type: 'probe', probe: await probe(photo, toRgb(req.ref), req.refDpi) })
    } else {
      const result = await photoToMarkup(photo, toRgb(req.ref), req.dpi, { ...req.options, log })
      post({ id: req.id, ok: true, type: 'run', result })
    }
  } catch (err) {
    // OpenCV throws bare numbers (pointers to C++ exceptions) when it runs out of memory or hits an assertion
    const error = err instanceof Error ? err.message : typeof err === 'number' ? `image processing failed (OpenCV error ${err}); the photo or the sheet may be too large` : String(err)
    post({ id: req.id, ok: false, error })
  }
}
