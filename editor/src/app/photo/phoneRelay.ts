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

/** Longest pause between polls while the connection is down. */
export const MAX_RETRY_MS = 10_000
/** Server errors in a row (not network drops) before the dialog gives up on a code. */
export const MAX_SERVER_ERRORS = 5

/** What the relay answered, short enough for the dialog: its plain-text message, else the status. */
async function relayError(r: Response): Promise<string> {
  const plain = (r.headers.get('content-type') ?? '').startsWith('text/plain')
  const msg = plain ? (await r.text().catch(() => '')).trim() : ''
  return msg && msg.length <= 200 ? msg : `the server answered ${r.status}`
}

/**
 * Wait for the photo in `slot`; resolves with it as a File. Rejects on abort, expiry or a relay error.
 *
 * A dropped connection (Wi-Fi gone, the laptop asleep) is not an error: the photo waits in the slot until the code
 * expires, so the dialog keeps asking, less often, and says it is reconnecting (`onConnection(false)`) until an answer
 * comes back (`onConnection(true)`). Only repeated error answers from the relay end the wait, with their message.
 */
export async function waitForPhoto(slot: string, signal: AbortSignal, now = () => Date.now(), onConnection?: (connected: boolean) => void): Promise<File> {
  const until = now() + SLOT_LIFETIME_MS
  let serverErrors = 0
  let drops = 0
  const setConnected = (ok: boolean) => {
    if (ok === (drops === 0)) return
    if (ok) drops = 0
    onConnection?.(ok)
  }
  while (!signal.aborted) {
    if (now() > until) throw new Error('The code has expired. Show a new one to send a photo.')
    let response: Response | undefined
    try {
      response = await fetch(`${RELAY}?id=${encodeURIComponent(slot)}`, { cache: 'no-store', signal })
    } catch {
      if (signal.aborted) break
      setConnected(false)
      drops++
    }
    if (response) {
      setConnected(true)
      if (response.status === 200) {
        const type = (response.headers.get('content-type') ?? 'image/jpeg').split(';')[0]
        const blob = await response.blob()
        return new File([blob], `phone-photo.${extOf(type)}`, { type })
      }
      if (response.status === 503) throw new Error(await response.text())
      if (response.status === 204) serverErrors = 0
      else if (++serverErrors >= MAX_SERVER_ERRORS) throw new Error(`Could not collect the photo: ${await relayError(response)}. Show a new code to try again.`)
    }
    const pause = drops ? Math.min(MAX_RETRY_MS, POLL_MS * 2 ** (drops - 1)) : POLL_MS
    await new Promise((r) => setTimeout(r, pause))
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
