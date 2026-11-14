/**
 * Reading binary `.drawing` files (decision 0008, spec `schema/schema/drawing-format.md`): gunzip with the platform
 * `DecompressionStream`, then the pure payload parser in core/drawing. An already decompressed payload (starts with
 * `DRAWING\0`) is accepted as is.
 */
import { DrawingFormatError, isDrawingPayload, isGzip, parseDrawingPayload, type DrawingDocument } from '@core/drawing'

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new DrawingFormatError('reading a .drawing needs DecompressionStream')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch (e) {
    throw new DrawingFormatError(`could not decompress the gzip stream: ${(e as Error).message}`)
  }
}

/** Parse the bytes of a `.drawing` file. Throws DrawingFormatError naming the problem (page, item, field). */
export async function parseDrawingFile(bytes: Uint8Array): Promise<DrawingDocument> {
  if (isDrawingPayload(bytes)) return parseDrawingPayload(bytes)
  if (!isGzip(bytes)) throw new DrawingFormatError('not a .drawing file: expected a gzip stream (it should start with bytes 1f 8b)')
  return parseDrawingPayload(await gunzip(bytes))
}
