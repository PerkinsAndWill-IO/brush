/**
 * Reading binary `.drawing` files (decisions 0008 and 0009). A file that starts with the raw magic `DRAWING\0` is the
 * zstd format (`schema/schema/drawing-format.md`, whatever its version number). A gzip stream (1f 8b) is the legacy
 * format (`drawing-format-legacy.md`): gunzip with the platform `DecompressionStream`, then the pure payload parser
 * in core/drawing.
 */
import {
  DrawingFormatError,
  fillLazyPage,
  isDrawingPayload,
  isGzip,
  parseDrawingPayload,
  parseLegacyDrawingPayload,
  type DrawingDocument,
} from '@core/drawing'

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new DrawingFormatError('reading a .drawing needs DecompressionStream')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch (e) {
    throw new DrawingFormatError(`could not decompress the gzip stream: ${(e as Error).message}`)
  }
}

/** Per document: one promise per page, settled once that page can be read without decoding it on the main thread. */
const decoding = new WeakMap<DrawingDocument, Promise<void>[]>()

/**
 * Settles when page `index` of `doc` is decoded off the main thread (or that failed, or there is no worker): read its
 * items after this so the UI does not stall on decoding. At once for documents not decoded by a worker.
 */
export function pageDecoded(doc: DrawingDocument, index: number): Promise<void> {
  return decoding.get(doc)?.[index] ?? Promise.resolve()
}

/** Decode the later pages of a lazy zstd document in a worker, from a copy of its bytes, and hand each to its page. */
function decodeInWorker(doc: DrawingDocument, bytes: Uint8Array): void {
  if (typeof Worker === 'undefined' || doc.pages.length < 2) return
  const done: (() => void)[] = []
  decoding.set(doc, doc.pages.map((_, i) => (i === 0 ? Promise.resolve() : new Promise<void>((r) => (done[i] = r)))))
  const finish = () => {
    done.forEach((r) => r?.())
    worker.terminate()
  }
  const worker = new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<import('./decode-worker').DecodedPage>) => {
    const { index, page } = e.data
    // a page posted without content did not decode: it is read, and fails, on the main thread
    if (page) fillLazyPage(doc.pages[index], page)
    done[index]()
    if (index === doc.pages.length - 1) finish()
  }
  worker.onerror = finish
  // ponytail: a copy of the whole file (~26 MB for kro-all); a 1 GB file wants the main thread to keep only what it reads
  const copy = bytes.slice()
  worker.postMessage(copy, [copy.buffer])
}

/** Parse the bytes of a `.drawing` file. Throws DrawingFormatError naming the problem (page, item, field). */
export async function parseDrawingFile(bytes: Uint8Array): Promise<DrawingDocument> {
  // the first page is decoded now; the others in a worker, or on first read if that is sooner
  if (isDrawingPayload(bytes)) {
    const doc = parseDrawingPayload(bytes, { lazy: true })
    decodeInWorker(doc, bytes)
    return doc
  }
  if (!isGzip(bytes)) throw new DrawingFormatError('not a .drawing file: expected a gzip stream (it should start with bytes 1f 8b)')
  return parseLegacyDrawingPayload(await gunzip(bytes))
}
