/**
 * Reading binary `.drawing` files (decisions 0008 and 0009). A file that starts with the raw magic `DRAWING\0` is the
 * zstd format (`schema/schema/drawing-format.md`, whatever its version number). A gzip stream (1f 8b) is the legacy
 * format (`drawing-format-legacy.md`): gunzip with the platform `DecompressionStream`, then the pure payload parser
 * in core/drawing.
 */
import {
  DrawingFormatError,
  decodeLazyFrame,
  drawingFrames,
  drawingHeaderEnd,
  fillLazyPage,
  isDrawingPayload,
  isGzip,
  lazyFrame,
  parseDrawingPayload,
  parseLegacyDrawingPayload,
  type DrawingDocument,
  type DrawingPage,
  type DrawItem,
  type LazyFrame,
} from '@core/drawing'
import { rememberAnalysis, type PageAnalysis } from '@core/context/drawing'
import type { ContextItem } from '@core/types'
import type { ElementsToDecode, FrameToDecode, PageChunk, PageEnd } from './decode-worker'

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new DrawingFormatError('reading a .drawing needs DecompressionStream')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch (e) {
    throw new DrawingFormatError(`could not decompress the gzip stream: ${(e as Error).message}`)
  }
}

/** Background loading of a lazy zstd document's later pages: get each frame, decode it, hand it to its page. */
interface Loading {
  /** Per page: settles once it can be read without waiting (decoded, or failed: then reading it throws). */
  ready: Promise<void>[]
  /** Per page: its frame's bytes are here, so reading it works (decoding on the main thread if need be). */
  available: boolean[]
  /** Pages ready so far. */
  done: number
  want(index: number): void
  watchers: Set<(done: number, total: number) => void>
}
const loading = new WeakMap<DrawingDocument, Loading>()

/**
 * Settles when page `index` of `doc` can be read without blocking: decoded off the main thread, or that failed (then
 * reading it throws the format error). Asking moves the page to the front of the background queue. At once for a
 * document that is not loading in the background.
 */
export function pageDecoded(doc: DrawingDocument, index: number): Promise<void> {
  const l = loading.get(doc)
  l?.want(index)
  return l?.ready[index] ?? Promise.resolve()
}

/** False while page `index` of a document opened by URL is still downloading: its items cannot be read yet. */
export function pageAvailable(doc: DrawingDocument, index: number): boolean {
  return loading.get(doc)?.available[index] ?? true
}

/** Calls `on(done, total)` now and whenever another page of `doc` gets ready; returns the unsubscribe. */
export function watchPages(doc: DrawingDocument, on: (done: number, total: number) => void): () => void {
  const l = loading.get(doc)
  on(l?.done ?? doc.pages.length, doc.pages.length)
  l?.watchers.add(on)
  return () => void l?.watchers.delete(on)
}

/** What a decoder hands back for a frame: the page's content and analysis, or nothing if it did not decode. */
type Decoded = { page?: Pick<DrawingPage, 'items' | 'boxes' | 'views'>; analysis?: PageAnalysis }
type Decoder = ((frame: Uint8Array, f: LazyFrame, index: number) => Promise<Decoded>) & { close(): void }

/**
 * Decodes (and analyses) frames in a module worker, in the order posted; resolves without a page for a frame that does
 * not decode. `elements` is the compressed elements table, which the analysis reads (a copy is posted). A page arrives
 * in chunks (see decode-worker.ts), each received in its own short task.
 */
function workerDecoder(elements?: Uint8Array): Decoder {
  const waiting = new Map<number, { resolve: (r: Decoded) => void; items: DrawItem[]; ctxItems: ContextItem[] }>()
  let worker: Worker | null = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<PageChunk | PageEnd>) => {
    const w = waiting.get(e.data.index)
    if (!w) return
    if (!('done' in e.data)) {
      if (e.data.items) for (const it of e.data.items) w.items.push(it)
      if (e.data.ctxItems) for (const it of e.data.ctxItems) w.ctxItems.push(it)
      return
    }
    waiting.delete(e.data.index)
    const { page, analysis } = e.data
    w.resolve({
      page: page && { ...page, items: w.items },
      analysis: analysis && { ...analysis, ctx: { ...analysis.ctx, items: w.ctxItems } },
    })
  }
  // a crashed worker decodes nothing more: its pages are decoded on the main thread when first read
  worker.onerror = () => {
    worker = null
    waiting.forEach((w) => w.resolve({}))
    waiting.clear()
  }
  if (elements) {
    const copy = elements.slice()
    worker.postMessage({ elements: copy } satisfies ElementsToDecode, [copy.buffer])
  }
  const decode = (frame: Uint8Array, f: LazyFrame, index: number) =>
    new Promise<Decoded>((resolve) => {
      if (!worker) return resolve({})
      waiting.set(index, { resolve, items: [], ctxItems: [] })
      worker.postMessage({ index, frame, header: f.header, name: f.name } satisfies FrameToDecode, [frame.buffer as ArrayBuffer])
    })
  return Object.assign(decode, { close: () => worker?.terminate() })
}

/** Without workers (Node): decode on the main thread, between other work (analysed there when first asked). */
const mainDecoder: Decoder = Object.assign(
  async (frame: Uint8Array, f: LazyFrame) => {
    try {
      return { page: decodeLazyFrame(frame, f) }
    } catch {
      return {}
    }
  },
  { close: () => {} },
)

/** Frames in flight at once; with workers, each lane has its own, so pages decode and analyse side by side. */
const LANES = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1))

/**
 * Load the pages of `doc` that are still lazy, in its page order (a page asked for by `pageDecoded` first), `LANES` at
 * a time: `frameOf` gets each compressed frame (its own copy: it is transferred), then a worker decodes and analyses
 * it (`elements`: the compressed elements table the analysis reads). With `downloading`, those pages cannot be read
 * until their frame has arrived.
 */
function loadInBackground(doc: DrawingDocument, frameOf: (f: LazyFrame) => Promise<Uint8Array>, downloading: boolean, elements?: Uint8Array): void {
  const frames = doc.pages.map((p) => lazyFrame(p))
  const todo = frames.flatMap((f, i) => (f ? [i] : []))
  if (!todo.length) return
  if (!downloading && typeof Worker === 'undefined') return // nothing gained: a page decodes on the main thread when read
  const settle: (() => void)[] = []
  const l: Loading = {
    ready: frames.map((f, i) => (f ? new Promise<void>((r) => (settle[i] = r)) : Promise.resolve())),
    available: frames.map((f) => !f || !downloading),
    done: doc.pages.length - todo.length,
    want(i) {
      const k = todo.indexOf(i)
      if (k > 0) todo.unshift(...todo.splice(k, 1))
    },
    watchers: new Set(),
  }
  loading.set(doc, l)
  const lane = async () => {
    const decode = typeof Worker === 'undefined' ? mainDecoder : workerDecoder(elements)
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      const f = frames[i]!
      try {
        const frame = await frameOf(f)
        l.available[i] = true
        const { page, analysis } = await decode(frame, f, i)
        // a page left lazy did not decode: reading it decodes it here and throws the format error
        if (page) fillLazyPage(doc.pages[i], page)
        if (page && analysis) rememberAnalysis(doc.pages[i], analysis)
      } catch (e) {
        // ponytail: a frame whose download failed stays unreadable (reading it throws); a retry would go here
        console.warn(`${f.name}: could not load`, e)
      }
      settle[i]()
      l.done++
      l.watchers.forEach((w) => w(l.done, doc.pages.length))
    }
    decode.close()
  }
  for (let k = 0; k < LANES; k++) void lane()
}

/** The compressed elements table of a zstd file whose bytes (or header and that frame) are in `bytes`. */
function elementsFrame(bytes: Uint8Array, ref = drawingFrames(bytes).elements): Uint8Array | undefined {
  return ref && ref[1] ? bytes.subarray(ref[0], ref[0] + ref[1]) : undefined
}

/** Parse the bytes of a `.drawing` file. Throws DrawingFormatError naming the problem (page, item, field). */
export async function parseDrawingFile(bytes: Uint8Array): Promise<DrawingDocument> {
  // the first page is decoded now; the others in a worker, or on first read if that is sooner
  if (isDrawingPayload(bytes)) {
    const doc = parseDrawingPayload(bytes, { lazy: true })
    loadInBackground(doc, async (f) => bytes.slice(f.at[0], f.at[0] + f.at[1]), false, elementsFrame(bytes))
    return doc
  }
  if (!isGzip(bytes)) throw new DrawingFormatError('not a .drawing file: expected a gzip stream (it should start with bytes 1f 8b)')
  return parseLegacyDrawingPayload(await gunzip(bytes))
}

/** Bytes a URL open fetches first: the preamble and, usually, the whole JSON header. */
const OPEN_BYTES = 1 << 16

/** The whole body, reporting the bytes received so far. */
async function readAll(res: Response, onBytes?: (n: number) => void): Promise<Uint8Array> {
  if (!res.body || !onBytes) return new Uint8Array(await res.arrayBuffer())
  const chunks: Uint8Array[] = []
  let n = 0
  for (const reader = res.body.getReader(); ; ) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    onBytes((n += value.length))
  }
  const out = new Uint8Array(n)
  chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0)
  return out
}

/**
 * Open a `.drawing` by URL, fetching only what the first sheet needs. With HTTP range requests (a 206 answer) and a
 * zstd file: the header, the first page's frame and the elements table, then the other frames in the background
 * (`pageDecoded`, `watchPages`). Anything else (no range support, a legacy or non-drawing file) is fetched whole and
 * returned as bytes to sniff; a failed fetch returns its HTTP status. `onBytes` reports the bytes received so far.
 */
export async function openDrawingUrl(
  url: string,
  onBytes?: (n: number) => void,
): Promise<{ doc: DrawingDocument } | { bytes: Uint8Array } | { status: number }> {
  const first = await fetch(url, { headers: { Range: `bytes=0-${OPEN_BYTES - 1}` } })
  if (!first.ok) return { status: first.status }
  if (first.status !== 206) return { bytes: await readAll(first, onBytes) }
  let head = new Uint8Array(await first.arrayBuffer())
  const end = drawingHeaderEnd(head)
  if (end === null) {
    const all = await fetch(url)
    return all.ok ? { bytes: await readAll(all, onBytes) } : { status: all.status }
  }
  let got = head.length
  onBytes?.(got)
  const range = async ([at, len]: [number, number]) => {
    const res = await fetch(url, { headers: { Range: `bytes=${at}-${at + len - 1}` } })
    const b = new Uint8Array(await res.arrayBuffer())
    if (res.status !== 206 || b.length !== len) throw new DrawingFormatError(`the server did not send bytes ${at}-${at + len - 1} (HTTP ${res.status}, ${b.length} bytes)`)
    onBytes?.((got += len))
    return b
  }
  if (end > head.length) {
    const whole = new Uint8Array(end)
    whole.set(head)
    whole.set(await range([head.length, end - head.length]), head.length)
    head = whole
  }
  const { pages, elements, size } = drawingFrames(head)
  // one buffer the size of the file; frames land at their offsets, so the reader works on it unchanged
  const file = new Uint8Array(size)
  file.set(head.subarray(0, size))
  const fetchInto = async (ref: [number, number]) => {
    const b = ref[1] ? await range(ref) : new Uint8Array()
    file.set(b, ref[0])
    return b
  }
  await Promise.all([pages[0], elements].map((ref) => ref && fetchInto(ref)))
  const doc = parseDrawingPayload(file, { lazy: true })
  loadInBackground(doc, (f) => fetchInto(f.at), true, elementsFrame(file, elements))
  return { doc }
}
