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
 *
 * Storage is a `PhotoStore`: Vercel Blob when deployed (the exported handlers), or a folder on disk when the dev
 * server has no Blob token (`relayWith`, used by vite.config.ts; see scripts/photo-relay-local-store.ts).
 */
import { del, get, list, put } from '@vercel/blob'

/** Where the relay keeps photos between the phone's upload and the dialog's pickup. */
export interface PhotoStore {
  /** Is storage connected? Without it the relay answers 503 "not set up". */
  configured(): boolean
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>
  /** The photo at `path`, or null when nothing is there. */
  read(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
  del(paths: string[]): Promise<void>
  list(prefix: string): Promise<{ pathname: string; uploadedAt: Date }[]>
}

const SLOT = /^[A-Za-z0-9_-]{22,64}$/
const PREFIX = 'photo-relay/'
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024
/** Photos not collected within this time are deleted by the next upload. */
const MAX_AGE_MS = 60 * 60 * 1000

const text = (status: number, message: string) => new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
const empty = (status = 204) => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

/**
 * The image type by its first bytes, or null. A copy of src/app/photo/imageType.ts (the phone page uses that one):
 * a function file must not import other project files, since Vercel runs it as plain ES modules, where an import
 * without a file extension fails. The relay tests check that the two agree.
 */
export function imageType(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/heic' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' && /^(hei[cxms]|hev[cxms]|mif1|msf1)$/.test(String.fromCharCode(...b.subarray(8, 12)))) return 'image/heic'
  return null
}

function slotOf(request: Request): string | null {
  const id = new URL(request.url).searchParams.get('id')
  return id && SLOT.test(id) ? id : null
}

const NOT_SET_UP = 'Phone upload is not set up on this deployment (no Vercel Blob store is connected).'

/** A private Vercel Blob store (decision 0011). */
export const blobStore: PhotoStore = {
  configured: () => !!(process.env.BLOB_READ_WRITE_TOKEN || (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID)),
  async put(path, bytes, contentType) {
    await put(path, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }), { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: true })
  },
  async read(path) {
    const found = await get(path, { access: 'private', useCache: false })
    if (!found || !found.stream) return null
    return { bytes: new Uint8Array(await new Response(found.stream).arrayBuffer()), contentType: found.blob.contentType ?? 'application/octet-stream' }
  },
  async del(paths) {
    await del(paths)
  },
  async list(prefix) {
    const { blobs } = await list({ prefix, limit: 100 })
    return blobs.map((b) => ({ pathname: b.pathname, uploadedAt: new Date(b.uploadedAt) }))
  },
}

/** The relay's handlers over `store`. */
export function relayWith(store: PhotoStore) {
  /** Delete photos nobody collected. Best effort: a failure here does not fail the upload. */
  async function sweep(now: number): Promise<void> {
    try {
      const old = (await store.list(PREFIX)).filter((b) => now - b.uploadedAt.getTime() > MAX_AGE_MS).map((b) => b.pathname)
      if (old.length) await store.del(old)
    } catch {
      // ignore
    }
  }

  async function post(request: Request): Promise<Response> {
    const id = slotOf(request)
    if (!id) return text(400, 'invalid upload link')
    if (!store.configured()) return text(503, NOT_SET_UP)
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > MAX_PHOTO_BYTES) return text(413, 'the photo is too large')
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (!bytes.length) return text(400, 'no photo')
    if (bytes.length > MAX_PHOTO_BYTES) return text(413, 'the photo is too large')
    const type = imageType(bytes)
    if (!type) return text(415, 'only JPEG, PNG or HEIC photos')
    await store.put(PREFIX + id, bytes, type)
    await sweep(Date.now())
    return empty()
  }

  async function get_(request: Request): Promise<Response> {
    const params = new URL(request.url).searchParams
    if (!params.has('id')) return new Response(JSON.stringify({ available: store.configured() }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
    const id = slotOf(request)
    if (!id) return text(400, 'invalid slot')
    if (!store.configured()) return text(503, NOT_SET_UP)
    const found = await store.read(PREFIX + id)
    if (!found) return empty()
    // collected: the photo leaves the store now
    await store.del([PREFIX + id]).catch(() => undefined)
    return new Response(found.bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': found.contentType, 'cache-control': 'no-store' } })
  }

  async function remove(request: Request): Promise<Response> {
    const id = slotOf(request)
    if (!id) return text(400, 'invalid slot')
    if (store.configured()) await store.del([PREFIX + id]).catch(() => undefined)
    return empty()
  }

  return { POST: guarded(post), GET: guarded(get_), DELETE: guarded(remove) }
}

/** A storage failure answers 502 with the store's message (it names no secrets), not a bare 500. */
const guarded =
  (handler: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    try {
      return await handler(request)
    } catch (e) {
      console.error('photo-relay', e)
      return text(502, `Storage error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

const relay = relayWith(blobStore)
export const POST = relay.POST
export const GET = relay.GET
export const DELETE = relay.DELETE
