/**
 * P1-11: a photo from a phone, handed over through /api/photo-relay (decision 0011). The desktop dialog makes a slot,
 * shows its link as a QR code and waits; the phone page (./PhoneUpload.tsx) sends the photo to the slot.
 */
import { imageType } from './imageType'

export const RELAY = '/api/photo-relay'
/** Largest photo the relay takes (the function's request limit is 4.5 MB). */
export const MAX_SEND_BYTES = 4 * 1024 * 1024 - 64 * 1024
/** How often the dialog asks whether the photo has arrived, and for how long. */
export const POLL_MS = 2000
export const SLOT_LIFETIME_MS = 15 * 60 * 1000

/** A new slot id: 128 random bits, base64url (22 characters). */
export function newSlotId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The link the QR code carries: the app itself, in phone-upload mode. */
export const phoneLink = (origin: string, slot: string) => `${origin}/?phone=${encodeURIComponent(slot)}`

/** A phone cannot open the desktop's own address. */
export const isLocalOrigin = (hostname: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.localhost)$/i.test(hostname)

/** Is a Blob store connected on this deployment? False on the dev server, which runs no functions. */
export async function relayAvailable(): Promise<boolean> {
  try {
    const r = await fetch(RELAY, { cache: 'no-store' })
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return false
    return !!((await r.json()) as { available?: boolean }).available
  } catch {
    return false
  }
}

const extOf = (type: string) => (type === 'image/png' ? 'png' : type === 'image/heic' ? 'heic' : 'jpg')

/** Wait for the photo in `slot`; resolves with it as a File. Rejects on abort, expiry or a relay error. */
export async function waitForPhoto(slot: string, signal: AbortSignal, now = () => Date.now()): Promise<File> {
  const until = now() + SLOT_LIFETIME_MS
  let failures = 0
  while (!signal.aborted) {
    if (now() > until) throw new Error('The code has expired. Show a new one to send a photo.')
    try {
      const r = await fetch(`${RELAY}?id=${encodeURIComponent(slot)}`, { cache: 'no-store', signal })
      if (r.status === 200) {
        const type = (r.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
        const blob = await r.blob()
        return new File([blob], `phone-photo.${extOf(type)}`, { type })
      }
      if (r.status === 503) throw new Error(await r.text())
      failures = r.status === 204 ? 0 : failures + 1
    } catch (e) {
      if (signal.aborted) break
      if (e instanceof Error && /not set up/.test(e.message)) throw e
      failures++
    }
    if (failures >= 5) throw new Error('Lost the connection while waiting for the photo. Show a new code to try again.')
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  throw new DOMException('stopped', 'AbortError')
}

/** Give up a slot (the dialog closed before the photo came). Best effort. */
export function dropSlot(slot: string): void {
  void fetch(`${RELAY}?id=${encodeURIComponent(slot)}`, { method: 'DELETE', keepalive: true }).catch(() => undefined)
}

/** The photo as the relay takes it: as it is when small enough, else a JPEG scaled until it fits. */
export async function fitForRelay(file: Blob, max = MAX_SEND_BYTES): Promise<Blob> {
  // by its bytes, not its declared type: a HEIC is sent as it is (the computer decodes it), whatever the phone calls it
  const type = imageType(new Uint8Array(await file.slice(0, 32).arrayBuffer()))
  if (file.size <= max && type) return file.type === type ? file : new Blob([file], { type })
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    let side = Math.min(4032, Math.max(bmp.width, bmp.height))
    for (let quality = 0.9; ; ) {
      const k = side / Math.max(bmp.width, bmp.height)
      const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k))
      const g = canvas.getContext('2d')
      if (!g) throw new Error('could not prepare the photo')
      g.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      const out = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      if (out.size <= max || side < 1200) return out
      if (quality > 0.75) quality -= 0.08
      else side = Math.round(side * 0.85)
    }
  } finally {
    bmp.close()
  }
}

/** Send a photo from the phone to `slot`. */
export async function sendPhoto(slot: string, file: Blob): Promise<void> {
  const body = await fitForRelay(file)
  const r = await fetch(`${RELAY}?id=${encodeURIComponent(slot)}`, { method: 'POST', body, headers: { 'content-type': body.type || 'application/octet-stream' } })
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `the upload failed (${r.status})`)
}
