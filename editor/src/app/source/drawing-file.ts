/**
 * Reading binary `.drawing` files (decisions 0008 and 0009, specs `schema/schema/drawing-format.md` and
 * `drawing-format-v2.md`). Version 1: gunzip with the platform
 * `DecompressionStream`, then the pure payload parser in core/drawing. An already decompressed payload (starts with
 * `DRAWING\0`) is accepted as is.
 */
import {
  DRAWING_FORMAT_VERSION_2,
  DrawingFormatError,
  drawingVersion,
  isDrawingPayload,
  isGzip,
  parseDrawingPayload,
  parseDrawingPayloadV2,
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

/** Parse the bytes of a `.drawing` file. Throws DrawingFormatError naming the problem (page, item, field). */
export async function parseDrawingFile(bytes: Uint8Array): Promise<DrawingDocument> {
  // Version 2 starts with the raw magic (its frames are zstd); a raw version 1 payload is accepted as is.
  if (isDrawingPayload(bytes)) return drawingVersion(bytes) === DRAWING_FORMAT_VERSION_2 ? parseDrawingPayloadV2(bytes) : parseDrawingPayload(bytes)
  if (!isGzip(bytes)) throw new DrawingFormatError('not a .drawing file: expected a gzip stream (it should start with bytes 1f 8b)')
  return parseDrawingPayload(await gunzip(bytes))
}
