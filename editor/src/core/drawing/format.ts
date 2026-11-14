/**
 * Reader for the binary `.drawing` format (version 1; spec: `schema/schema/drawing-format.md`). Pure and
 * DOM-free: the whole file's bytes in, the same pages as the legacy format in SHEET coordinates out (decision 0009).
 *
 * The file is the raw magic, version 1, a JSON header and independent zstd frames: one per page and one for the
 * elements table. Coordinates are i32 in 0.01 mm units relative to the page `min`, delta-coded per blob. Each blob
 * is decoded in one loop that undoes the delta, dequantises and converts to sheet points
 * (x_pt = X * 864 / 30480, y_pt = height_pt - Y * 864 / 30480), the same space the legacy format yields after its transform.
 *
 * Reading rules: the legacy format's, applied within each page frame, plus a frame outside the file or that does not
 * decompress (naming the page or `elements`), a `unitsPerFoot` other than 30480, a box that is not four integers,
 * and a decoded coordinate that overflows i32.
 */
import { decompress } from 'fzstd'
import {
  DrawingFormatError,
  PT_PER_FT,
  blobRef,
  fail,
  isDrawingPayload,
  parsePage,
  type BlobSource,
  type DrawingDocument,
  type DrawingElement,
  type DrawingPage,
  type DrawingView,
  type ViewType,
  VIEW_TYPES,
} from './format-legacy'

export const DRAWING_FORMAT_VERSION = 1
// ponytail: remove-later shim. Files written while this format was still called "version 2" carry 2 in both version
// fields; accept them until none are left, then drop this constant and `readsVersion`.
const PRE_RENAME_VERSION = 2
const readsVersion = (v: unknown) => v === DRAWING_FORMAT_VERSION || v === PRE_RENAME_VERSION
/** One unit is 0.01 mm of paper: 304.8 mm per foot / 0.01. */
export const UNITS_PER_FOOT = 30480

const PREAMBLE = 16
const I32_MIN = -2147483648
const I32_MAX = 2147483647
/** Sheet points per unit. */
const PT_PER_UNIT = PT_PER_FT / UNITS_PER_FOOT

/** Blobs of one page frame: delta-coded i32, converted to sheet points while decoding. */
class DeltaBlobs implements BlobSource {
  private readonly size: number
  private readonly dv: DataView
  constructor(
    private frame: Uint8Array,
    private start: number,
    private heightPt: number,
  ) {
    this.size = frame.length - start
    this.dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  }

  coords(v: unknown, what: string, unit: number): Float32Array {
    const [off, len] = blobRef(v, what, unit * 4, this.size)
    const { dv, heightPt } = this
    const from = this.start + off
    const out = new Float32Array(len / 4)
    const overflow = (k: number) => fail(what, `coordinate ${k} overflows a 32-bit integer`)
    if (unit === 2) {
      // x0, y0, dx1, dy1, ...: point k = point k-1 + d
      let X = 0
      let Y = 0
      for (let k = 0; k < out.length; k += 2) {
        X += dv.getInt32(from + 4 * k, true)
        Y += dv.getInt32(from + 4 * k + 4, true)
        if (X < I32_MIN || X > I32_MAX) overflow(k)
        if (Y < I32_MIN || Y > I32_MAX) overflow(k + 1)
        out[k] = X * PT_PER_UNIT
        out[k + 1] = heightPt - Y * PT_PER_UNIT
      }
    } else {
      // dsx, dsy, dex, dey: start = previous end + ds, end = start + de
      let ex = 0
      let ey = 0
      for (let k = 0; k < out.length; k += 4) {
        const sx = ex + dv.getInt32(from + 4 * k, true)
        const sy = ey + dv.getInt32(from + 4 * k + 4, true)
        ex = sx + dv.getInt32(from + 4 * k + 8, true)
        ey = sy + dv.getInt32(from + 4 * k + 12, true)
        if (sx < I32_MIN || sx > I32_MAX) overflow(k)
        if (sy < I32_MIN || sy > I32_MAX) overflow(k + 1)
        if (ex < I32_MIN || ex > I32_MAX) overflow(k + 2)
        if (ey < I32_MIN || ey > I32_MAX) overflow(k + 3)
        out[k] = sx * PT_PER_UNIT
        out[k + 1] = heightPt - sy * PT_PER_UNIT
        out[k + 2] = ex * PT_PER_UNIT
        out[k + 3] = heightPt - ey * PT_PER_UNIT
      }
    }
    return out
  }

  bytes(v: unknown, what: string): Uint8Array {
    const [off, len] = blobRef(v, what, 1, this.size)
    return this.frame.subarray(this.start + off, this.start + off + len)
  }
}

function frameRef(v: unknown, what: string, fileSize: number): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || v[0] < 0 || v[1] < 0)
    fail(what, 'expected a frame reference [byteOffset, byteLength]')
  const [off, len] = v as [number, number]
  if (off + len > fileSize) fail(what, `[${off}, ${len}] is outside the file (${fileSize} bytes)`)
  return [off, len]
}

function unzstd(bytes: Uint8Array, [off, len]: [number, number], what: string): Uint8Array {
  try {
    return decompress(bytes.subarray(off, off + len))
  } catch (e) {
    return fail(what, `does not decompress: ${(e as Error).message}`)
  }
}

function utf8Json(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (e) {
    return fail(what, `not valid UTF-8 JSON: ${(e as Error).message}`)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A view type string; an unknown one reads as `other`. */
const viewTypeOf = (v: unknown, what: string): ViewType => {
  if (typeof v !== 'string') fail(what, `expected a string, got ${JSON.stringify(v)}`)
  return (VIEW_TYPES as readonly string[]).includes(v as string) ? (v as ViewType) : 'other'
}

/** One page frame: u32 J, page JSON, padding to 4, buffer. */
function parsePageFrame(frame: Uint8Array, header: unknown): DrawingPage {
  if (frame.length < 4) fail('frame', `${frame.length} bytes is shorter than the 4-byte JSON length`)
  const json = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true)
  if (4 + json > frame.length) fail('frame', `page JSON length ${json} runs past the end of the frame (${frame.length} bytes)`)
  const start = (4 + json + 3) & ~3
  if (start > frame.length) fail('frame', 'the frame ends inside the padding after the page JSON')
  const body = utf8Json(frame.subarray(4, 4 + json), 'frame page JSON')
  if (!isObject(body)) fail('frame page JSON', 'expected an object')
  const o = body as Record<string, unknown>
  const page = parsePage({ ...(header as object), items: o.items }, (min, max) => new DeltaBlobs(frame, start, (max[1] - min[1]) * PT_PER_FT))
  const h = page.sizePt.h
  const toSheet = (b: unknown, what: string): [number, number, number, number] => {
    if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isInteger)) fail(what, 'expected four integers [x0, y0, x1, y1]')
    const [x0, y0, x1, y1] = b as number[]
    // y flips with the page: the y-up box's top edge (y1) is the sheet box's minimum y
    return [Math.min(x0, x1) * PT_PER_UNIT, h - Math.max(y0, y1) * PT_PER_UNIT, Math.max(x0, x1) * PT_PER_UNIT, h - Math.min(y0, y1) * PT_PER_UNIT]
  }
  if (o.boxes !== undefined && o.boxes !== null) {
    if (!isObject(o.boxes)) fail('boxes', 'expected an object of element id to [x0, y0, x1, y1]')
    const boxes: NonNullable<DrawingPage['boxes']> = {}
    for (const [el, b] of Object.entries(o.boxes as Record<string, unknown>)) boxes[el] = toSheet(b, `boxes[${JSON.stringify(el)}]`)
    page.boxes = boxes
  }
  const hdr = header as Record<string, unknown>
  if (hdr.viewType !== undefined && hdr.viewType !== null) page.viewType = viewTypeOf(hdr.viewType, 'viewType')
  if (o.views !== undefined && o.views !== null) {
    if (!isObject(o.views)) fail('views', 'expected an object of view id to {type, name, scale, box}')
    const views: Record<string, DrawingView> = {}
    for (const [id, v] of Object.entries(o.views as Record<string, unknown>)) {
      const at = `views[${JSON.stringify(id)}]`
      if (!isObject(v)) fail(at, 'expected an object {type, name, scale, box}')
      const r = v as Record<string, unknown>
      const view: DrawingView = {
        type: viewTypeOf(r.type, `${at}.type`),
        name: typeof r.name === 'string' ? r.name : '',
        scale: typeof r.scale === 'string' ? r.scale : null,
      }
      if (r.box !== undefined && r.box !== null) view.box = toSheet(r.box, `${at}.box`)
      views[id] = view
    }
    page.views = views
  }
  return page
}

/** Parse the bytes of a `.drawing` file (raw, not gzipped). Pages are decoded sheets first, the first sheet first. */
export function parseDrawingPayload(bytes: Uint8Array): DrawingDocument {
  if (bytes.length < PREAMBLE) throw new DrawingFormatError(`not a .drawing file: ${bytes.length} bytes is shorter than the ${PREAMBLE}-byte preamble`)
  if (!isDrawingPayload(bytes)) throw new DrawingFormatError('not a .drawing file: bad magic (expected DRAWING\\0)')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = dv.getUint32(8, true)
  if (!readsVersion(version)) throw new DrawingFormatError(`unsupported .drawing version ${version} (this reader reads version ${DRAWING_FORMAT_VERSION})`)
  const headerLen = dv.getUint32(12, true)
  if (PREAMBLE + headerLen > bytes.length) throw new DrawingFormatError(`header length ${headerLen} runs past the end of the file (${bytes.length} bytes)`)

  let header: unknown
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(PREAMBLE, PREAMBLE + headerLen)))
  } catch (e) {
    throw new DrawingFormatError(`header is not valid UTF-8 JSON: ${(e as Error).message}`)
  }
  if (!isObject(header)) throw new DrawingFormatError('header: expected a JSON object')
  const h = header as Record<string, unknown>
  if (h.format !== 'drawing') throw new DrawingFormatError(`header.format: expected "drawing", got ${JSON.stringify(h.format)}`)
  if (h.version !== undefined && h.version !== version)
    throw new DrawingFormatError(`header.version ${JSON.stringify(h.version)} disagrees with the preamble version ${version}`)
  if (h.unitsPerFoot !== UNITS_PER_FOOT) throw new DrawingFormatError(`header.unitsPerFoot: expected ${UNITS_PER_FOOT}, got ${JSON.stringify(h.unitsPerFoot)}`)
  if (!Array.isArray(h.pages)) throw new DrawingFormatError('header.pages: expected an array')

  const named = <T>(what: string, run: () => T): T => {
    try {
      return run()
    } catch (e) {
      if (e instanceof DrawingFormatError) throw new DrawingFormatError(`${what}.${e.message}`)
      throw e
    }
  }

  // Sheets first (the viewer's order), so the page that is shown first is decoded first.
  const rawPages = h.pages as unknown[]
  const order = rawPages.map((_, i) => i).sort((a, b) => Number((rawPages[a] as { kind?: unknown })?.kind !== 'sheet') - Number((rawPages[b] as { kind?: unknown })?.kind !== 'sheet') || a - b)
  const pages = order.map((i) =>
    named(`pages[${i}]`, () => {
      const raw = rawPages[i]
      if (!isObject(raw)) fail('page', 'expected an object')
      const ref = frameRef((raw as Record<string, unknown>).frame, 'frame', bytes.length)
      return parsePageFrame(unzstd(bytes, ref, 'frame'), raw)
    }),
  )

  // The elements table comes after the pages; a viewer that paints page 0 first could load it later.
  let elements: Record<string, DrawingElement> = {}
  if (h.elements !== undefined && h.elements !== null) {
    elements = named('elements', () => {
      const body = utf8Json(unzstd(bytes, frameRef(h.elements, 'frame', bytes.length), 'frame'), 'frame')
      if (!isObject(body)) fail('frame', 'expected a JSON object of elements')
      return body as Record<string, DrawingElement>
    })
  }

  const src = isObject(h.source) ? (h.source as Record<string, unknown>) : {}
  const source: DrawingDocument['source'] = {}
  if (typeof src.file === 'string') source.file = src.file
  if (typeof src.generator === 'string') source.generator = src.generator
  return { source, pages, elements }
}
