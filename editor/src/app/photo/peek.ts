/**
 * "First glance" (P1-13): while the photo is read, a small preview of it goes to the hosted model (the same
 * AI Gateway proxy as the second pass) for one short line about what the markup seems to show, to read while you wait.
 *
 * Opt-in from the import dialog: the pipeline itself keeps photos on the machine (decision 0009), so this is the only
 * part that sends anything, and only a ~640 px preview. Any failure (no gateway key, offline, refused) just means
 * no line: it never holds up or fails the import.
 */
import { rescoreSettingsFromEnv } from '../rescore/env'

const PEEK_KEY = 'brush.photo.peek'
const MODEL = 'anthropic/claude-haiku-5.5'
const PREVIEW_SIDE = 640

const SYSTEM =
  "You glance at a phone photo of an architect's markup: pen or marker sketched on trace paper laid over a printed plan. " +
  'Look for the bold hand-drawn marker lines: they differ from the thin printed CAD linework. ' +
  'Reply with ONE short, warm sentence (at most 20 words) saying what the new markup seems to propose, in plain words an architect would use. ' +
  'Name rooms, walls, doors or furniture you can actually see, and be decisive rather than hedging. No preamble, no quotes, no emoji.'

export const peekPreference = {
  get(): boolean {
    try {
      return globalThis.localStorage?.getItem(PEEK_KEY) === '1'
    } catch {
      return false
    }
  },
  set(on: boolean) {
    try {
      globalThis.localStorage?.setItem(PEEK_KEY, on ? '1' : '0')
    } catch {
      /* not remembered */
    }
  },
}

/** A JPEG preview of the photo, long side at most PREVIEW_SIDE px, base64 (no data: prefix). */
async function preview(photo: Blob): Promise<string> {
  const bmp = await createImageBitmap(photo, { imageOrientation: 'from-image' })
  const k = Math.min(1, PREVIEW_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const c = new OffscreenCanvas(w, h)
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.62 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** One line about the photo, or null. */
export async function firstGlance(photo: Blob, signal?: AbortSignal): Promise<string | null> {
  try {
    const base = rescoreSettingsFromEnv().settings.hostedBaseUrl
    const data = await preview(photo)
    const res = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        // the model may think first; 400 leaves room for that within the proxy's cap (api/ai-gateway.ts)
        max_tokens: 400,
        temperature: 0.6,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
              { type: 'text', text: 'What does the markup show?' },
            ],
          },
        ],
      }),
    })
    if (!res.ok) {
      console.warn('first glance: the model did not answer', res.status, (await res.text()).slice(0, 300))
      return null
    }
    const body = (await res.json()) as { content?: { type: string; text?: string }[] }
    const text = body.content?.find((c) => c.type === 'text')?.text?.trim()
    return text ? text.replace(/^["“]|["”]$/g, '') : null
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') console.warn('first glance failed', e)
    return null
  }
}
