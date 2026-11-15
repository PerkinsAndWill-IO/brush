/**
 * Vercel Function: hands a photo from a phone to the desktop's photo-import dialog (P1-11).
 *
 * The dialog makes a random slot id and shows a QR code for `/?phone=<id>`. The phone page posts the photo here;
 * the dialog polls GET until it is there, receives it and the photo is deleted. Photos sit in a private Vercel Blob
 * store (decision 0011): never public, read only through this function, and deleted when collected or after an
 * hour.
 *
 *   POST   /api/photo-relay?id=<slot>   body: the image (JPEG, PNG or HEIC, at most 4 MB)  -> 204
 *   GET    /api/photo-relay?id=<slot>   -> 204 nothing yet | 200 the image (and it is deleted)
 *   GET    /api/photo-relay             -> 200 {available} (is a Blob store connected?)
 *   DELETE /api/photo-relay?id=<slot>   -> 204 (the dialog closed)
 *
 * The slot id (128 random bits, only on the desktop's screen) is the only key. Narrow on purpose: image types only,
 * checked by their first bytes, and a size cap below the 4.5 MB request limit of Vercel Functions.
 */
import { del, get, list, put } from '@vercel/blob'
import { imageType } from '../src/app/photo/imageType'

const SLOT = /^[A-Za-z0-9_-]{22,64}$/
const PREFIX = 'photo-relay/'
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024
/** Photos not collected within this time are deleted by the next upload. */
const MAX_AGE_MS = 60 * 60 * 1000

const text = (status: number, message: string) => new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
const empty = (status = 204) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

export { imageType }

function slotOf(request: Request): string | null {
  const id = new URL(request.url).searchParams.get('id')
  return id && SLOT.test(id) ? id : null
}

const configured = () => !!(process.env.BLOB_READ_WRITE_TOKEN || (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID))
const NOT_SET_UP = 'Phone upload is not set up on this deployment (no Vercel Blob store is connected).'

/** Delete photos nobody collected. Best effort: a failure here does not fail the upload. */
async function sweep(now: number): Promise<void> {
  try {
    const { blobs } = await list({ prefix: PREFIX, limit: 100 })
    const old = blobs.filter((b) => now - new Date(b.uploadedAt).getTime() > MAX_AGE_MS).map((b) => b.pathname)
    if (old.length) await del(old)
  } catch {
    // ignore
  }
}

export async function POST(request: Request): Promise<Response> {
  const id = slotOf(request)
  if (!id) return text(400, 'invalid upload link')
  if (!configured()) return text(503, NOT_SET_UP)
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_PHOTO_BYTES) return text(413, 'the photo is too large')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (!bytes.length) return text(400, 'no photo')
  if (bytes.length > MAX_PHOTO_BYTES) return text(413, 'the photo is too large')
  const type = imageType(bytes)
  if (!type) return text(415, 'only JPEG, PNG or HEIC photos')
  await put(PREFIX + id, new Blob([bytes], { type }), { access: 'private', contentType: type, addRandomSuffix: false, allowOverwrite: true })
  await sweep(Date.now())
  return empty()
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  if (!params.has('id')) return new Response(JSON.stringify({ available: configured() }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  const id = slotOf(request)
  if (!id) return text(400, 'invalid slot')
  if (!configured()) return text(503, NOT_SET_UP)
  const found = await get(PREFIX + id, { access: 'private', useCache: false })
  if (!found || !found.stream) return empty()
  const body = new Uint8Array(await new Response(found.stream).arrayBuffer())
  // collected: the photo leaves the store now
  await del(PREFIX + id).catch(() => undefined)
  return new Response(body, { headers: { 'content-type': found.blob.contentType ?? 'application/octet-stream', 'cache-control': 'no-store' } })
}

export async function DELETE(request: Request): Promise<Response> {
  const id = slotOf(request)
  if (!id) return text(400, 'invalid slot')
  if (configured()) await del(PREFIX + id).catch(() => undefined)
  return empty()
}
