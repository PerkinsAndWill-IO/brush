/**
 * Reader for the gzip `.drawing` format, the legacy one (spec: `schema/schema/drawing-format-legacy.md` in this repo,
 * header schema `schema/schema/drawing.schema.json`). Pure and DOM-free: decompressed payload bytes in,
 * pages in SHEET coordinates out (see decision 0008).
 *
 * The file stores paper feet, x right, y up, page rectangle `min..max`. The editor works in sheet points
 * (1/72 in), origin top-left, y down (core/types), so every coordinate, width, dash and text size is
 * converted here once: x_pt = (x - min.x) * 864, y_pt = (max.y - y) * 864.
 *
 * Gzip is the caller's job (the app uses the platform `DecompressionStream`); `isGzip` sniffs it.
 * Reading rules follow the spec: bad magic, an unknown version, a header that overruns the file or is not UTF-8
 * JSON of the right shape, a blob outside the buffer or misaligned, a coordinate blob of the wrong length or
 * with a non-finite value each throw a DrawingFormatError naming the page, item and field. Unknown item types
 * are skipped.
 */
import type { Point, Rect } from '../types'

export const LEGACY_DRAWING_VERSION = 1
/** Points per paper foot: 12 in x 72 pt. */
export const PT_PER_FT = 864

const MAGIC = [0x44, 0x52, 0x41, 0x57, 0x49, 0x4e, 0x47, 0x00] // "DRAWING\0"
const PREAMBLE = 16 // magic (8) + version (4) + header length (4)

export class DrawingFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DrawingFormatError'
  }
}

export type Rgb = [number, number, number]

/** Element metadata, shared by all pages (scene contract `elements`). */
export interface DrawingElement {
  class?: string
  category?: string | null
  name?: string | null
  family?: string | null
  type?: string | null
  level?: string | null
  /** On tags: the element the tag labels. */
  tagged?: number | null
  params?: Array<{ name: string; value: string }>
}

interface Common {
  /** Element id (a key of `elements`) or null. */
  el: string | null
  /** Id of the view (viewport) the item was drawn from, or null. */
  view: string | null
}

/** Flat x,y pairs in sheet points. */
export interface DrawPath extends Common {
  t: 'path'
  xy: Float32Array
  closed: boolean
  /** Stroke width in points. */
  w: number
  c: Rgb
  /** On/off lengths in points; empty = solid. */
  dash: number[]
}

/** Flat x0,y0,x1,y1 per independent segment, sheet points. */
export interface DrawSegs extends Common {
  t: 'segs'
  xy: Float32Array
  w: number
  c: Rgb
  dash: number[]
}

/** Even-odd fill over all rings; each ring flat x,y pairs in sheet points. */
export interface DrawFill extends Common {
  t: 'fill'
  rings: Float32Array[]
  c: Rgb
}

export interface DrawText extends Common {
  t: 'text'
  text: string
  /** The point named by `anchor`, sheet points. */
  at: Point
  /** Capital height in points. */
  size: number
  /** Horizontal l|c|r then vertical t|m|b. */
  anchor: string
  /** Unit baseline direction in sheet space (y down). */
  dir: Point
  /** Wrap width in points, or null. */
  maxWidth: number | null
  c: Rgb
  bold: boolean
}

export interface DrawImage extends Common {
  t: 'image'
  /** Image rectangle in sheet points (top-left origin). The PNG's first row is the top edge. */
  rect: Rect
  png: Uint8Array
}

export type DrawItem = DrawPath | DrawSegs | DrawFill | DrawText | DrawImage

export const VIEW_TYPES = ['plan', 'ceiling', 'structural-plan', 'area-plan', 'elevation', 'section', 'detail', 'drafting', 'axon', 'perspective', 'legend', 'schedule', 'rendering', 'other'] as const
export type ViewType = (typeof VIEW_TYPES)[number]

/** One view on a page (zstd files only). `box` is the viewport rectangle in sheet points, absent for a view's own page. */
export interface DrawingView {
  type: ViewType
  name: string
  scale: string | null
  box?: [number, number, number, number]
}

export interface DrawingPage {
  /** Host id of the sheet or view, as a string. */
  id: string
  kind: 'sheet' | 'view'
  number: string | null
  name: string
  /** Scale text as stored ("1 : 100"), or null. */
  scale: string | null
  sizePt: { w: number; h: number }
  /** Items in draw order, sheet points. */
  items: DrawItem[]
  /**
   * Zstd files only: per element id, the bounding box of its geometry on this page, [minX, minY, maxX, maxY]
   * in sheet points (for culling and picking; text anchors may be missing). Absent for legacy files.
   */
  boxes?: Record<string, [number, number, number, number]>
  /** Zstd files only, on a `view` page: what kind of view it is. Absent when the file does not say. */
  viewType?: ViewType
  /** Zstd files only: the views on this page keyed by view id (the `view` of its items). */
  views?: Record<string, DrawingView>
}

export interface DrawingDocument {
  source: { file?: string; generator?: string }
  /** Sheets first, then views; header order within each kind (the order the viewer lists them). */
  pages: DrawingPage[]
  elements: Record<string, DrawingElement>
}

/** A gzip stream starts with 1f 8b. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/** A decompressed payload starts with the magic `DRAWING\0`. */
export function isDrawingPayload(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.every((b, k) => bytes[k] === b)
}

// ───────────────────────────── field helpers ─────────────────────────────

export const fail = (what: string, msg: string): never => {
  throw new DrawingFormatError(`${what}: ${msg}`)
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(what, 'expected a number')
  return v as number
}

function pair(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length < 2) fail(what, 'expected [x, y]')
  const a = v as unknown[]
  return [num(a[0], what), num(a[1], what)]
}

function rgb(v: unknown, what: string): Rgb {
  if (v === undefined || v === null) return [0, 0, 0]
  if (!Array.isArray(v) || v.length < 3) fail(what, 'expected [r, g, b]')
  const a = v as unknown[]
  return [num(a[0], what), num(a[1], what), num(a[2], what)]
}

function id(v: unknown, what: string): string | null {
  if (v === undefined || v === null) return null
  return String(num(v, what))
}

export function nullableStr(v: unknown, what: string): string | null {
  if (v === undefined || v === null) return null
  if (typeof v === 'number') return String(v)
  if (typeof v !== 'string') fail(what, 'expected a string')
  return v as string
}

function dashList(v: unknown, what: string): number[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) fail(what, 'expected a list')
  return (v as unknown[]).map((d) => num(d, what) * PT_PER_FT)
}

// ───────────────────────────── blobs ─────────────────────────────

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

/** Where a page's blobs come from: a legacy buffer of f32 or a zstd frame of delta-coded integers. */
export interface BlobSource {
  /**
   * Coordinates as sheet points in a fresh array: x_pt = (x - minX) * 864, y_pt = (maxY - y) * 864, with `x`, `y`
   * in paper feet. `unit` floats per record (2 points, 4 segments). The zstd format stores quantised integers relative to
   * the page `min` and converts while decoding, so it ignores `minX` and `maxY`.
   */
  coords(v: unknown, what: string, unit: number, minX: number, maxY: number): Float32Array
  bytes(v: unknown, what: string): Uint8Array
}

/** Checks a blob reference against a buffer of `size` bytes: bounds, offset a multiple of 4, length a multiple of `align`. */
export function blobRef(v: unknown, what: string, align: number, size: number): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || v[0] < 0 || v[1] < 0)
    fail(what, 'expected a blob reference [byteOffset, byteLength]')
  const [off, len] = v as [number, number]
  if (off + len > size) fail(what, `blob [${off}, ${len}] is out of bounds (the buffer has ${size} bytes)`)
  if (off % 4 !== 0) fail(what, `blob offset ${off} is not a multiple of 4`)
  if (len % align !== 0) fail(what, `blob length ${len} is not a multiple of ${align}`)
  return [off, len]
}

class Blobs implements BlobSource {
  private readonly size: number
  constructor(
    private payload: Uint8Array,
    private start: number,
  ) {
    this.size = payload.length - start
  }

  private ref(v: unknown, what: string, align: number): [number, number] {
    return blobRef(v, what, align, this.size)
  }

  /**
   * f32 x,y data converted to sheet points into a fresh array: x_pt = (x - minX) * 864, y_pt = (maxY - y) * 864.
   * `unit` floats per record (2 points, 4 segments). Blob offsets are 4-aligned in the buffer, so a 4-aligned
   * payload is read through a Float32Array; any other alignment falls back to a DataView.
   */
  coords(v: unknown, what: string, unit: number, minX: number, maxY: number): Float32Array {
    const [off, len] = this.ref(v, what, unit * 4)
    const at = this.payload.byteOffset + this.start + off
    const out = new Float32Array(len / 4)
    const n = out.length
    if (LITTLE_ENDIAN && at % 4 === 0) {
      const src = new Float32Array(this.payload.buffer, at, n)
      for (let k = 0; k < n; k += 2) {
        const x = src[k]
        const y = src[k + 1]
        if (!Number.isFinite(x)) fail(what, `coordinate ${k} is not a finite number`)
        if (!Number.isFinite(y)) fail(what, `coordinate ${k + 1} is not a finite number`)
        out[k] = (x - minX) * PT_PER_FT
        out[k + 1] = (maxY - y) * PT_PER_FT
      }
    } else {
      const dv = new DataView(this.payload.buffer, at, len)
      for (let k = 0; k < n; k += 2) {
        const x = dv.getFloat32(4 * k, true)
        const y = dv.getFloat32(4 * k + 4, true)
        if (!Number.isFinite(x)) fail(what, `coordinate ${k} is not a finite number`)
        if (!Number.isFinite(y)) fail(what, `coordinate ${k + 1} is not a finite number`)
        out[k] = (x - minX) * PT_PER_FT
        out[k + 1] = (maxY - y) * PT_PER_FT
      }
    }
    return out
  }

  bytes(v: unknown, what: string): Uint8Array {
    const [off, len] = this.ref(v, what, 1)
    return this.payload.subarray(this.start + off, this.start + off + len)
  }
}

// ───────────────────────────── pages ─────────────────────────────

function parseItem(o: Record<string, unknown>, at: string, blobs: BlobSource, min: [number, number], max: [number, number]): DrawItem | null {
  const X = (x: number) => (x - min[0]) * PT_PER_FT
  const Y = (y: number) => (max[1] - y) * PT_PER_FT
  const common = { el: id(o.el, `${at}.el`), view: id(o.view, `${at}.view`) }
  switch (o.t) {
    case 'path':
      return {
        t: 'path',
        xy: blobs.coords(o.pts, `${at}.pts`, 2, min[0], max[1]),
        closed: o.closed === true,
        w: num(o.w, `${at}.w`) * PT_PER_FT,
        c: rgb(o.c, `${at}.c`),
        dash: dashList(o.dash, `${at}.dash`),
        ...common,
      }
    case 'segs':
      return {
        t: 'segs',
        xy: blobs.coords(o.segs, `${at}.segs`, 4, min[0], max[1]),
        w: num(o.w, `${at}.w`) * PT_PER_FT,
        c: rgb(o.c, `${at}.c`),
        dash: dashList(o.dash, `${at}.dash`),
        ...common,
      }
    case 'fill': {
      if (!Array.isArray(o.rings)) fail(`${at}.rings`, 'expected a list of rings')
      const rings = (o.rings as unknown[]).map((r, k) => blobs.coords(r, `${at}.rings[${k}]`, 2, min[0], max[1]))
      return { t: 'fill', rings, c: rgb(o.c, `${at}.c`), ...common }
    }
    case 'text': {
      if (typeof o.text !== 'string') fail(`${at}.text`, 'expected a string')
      const d = o.dir === undefined || o.dir === null ? ([1, 0] as [number, number]) : pair(o.dir, `${at}.dir`)
      const len = Math.hypot(d[0], d[1])
      const p = pair(o.at, `${at}.at`)
      return {
        t: 'text',
        text: o.text as string,
        at: { x: X(p[0]), y: Y(p[1]) },
        size: num(o.size, `${at}.size`) * PT_PER_FT,
        anchor: typeof o.anchor === 'string' && /^[lcr][tmb]$/.test(o.anchor) ? o.anchor : 'lb',
        // y flips: a y-up direction (dx, dy) is (dx, -dy) in sheet space
        dir: len > 0 ? { x: d[0] / len, y: -d[1] / len } : { x: 1, y: 0 },
        maxWidth: o.maxWidth === undefined || o.maxWidth === null ? null : num(o.maxWidth, `${at}.maxWidth`) * PT_PER_FT,
        c: rgb(o.c, `${at}.c`),
        bold: o.bold === true,
        ...common,
      }
    }
    case 'image': {
      const a = pair(o.min, `${at}.min`)
      const b = pair(o.max, `${at}.max`)
      return {
        t: 'image',
        rect: { x: X(a[0]), y: Y(b[1]), w: (b[0] - a[0]) * PT_PER_FT, h: (b[1] - a[1]) * PT_PER_FT },
        png: blobs.bytes(o.png, `${at}.png`),
        ...common,
      }
    }
    default:
      return null // unknown item types are skipped (a newer exporter must not break the editor)
  }
}

/** `blobsFor` gets the validated page rectangle (paper feet), so the zstd reader can convert while decoding. */
export function parsePage(raw: unknown, blobsFor: (min: [number, number], max: [number, number]) => BlobSource): DrawingPage {
  if (typeof raw !== 'object' || raw === null) fail('page', 'expected an object')
  const o = raw as Record<string, unknown>
  if (o.kind !== 'sheet' && o.kind !== 'view') fail('kind', `expected "sheet" or "view", got ${JSON.stringify(o.kind)}`)
  const pageId = String(num(o.id, 'id'))
  const min = pair(o.min, 'min')
  const max = pair(o.max, 'max')
  if (!(max[0] > min[0]) || !(max[1] > min[1])) fail('max', 'must be greater than min (a page must have an area)')
  if (!Array.isArray(o.items)) fail('items', 'expected an array')
  const blobs = blobsFor(min, max)
  const items: DrawItem[] = []
  ;(o.items as unknown[]).forEach((it, i) => {
    if (typeof it !== 'object' || it === null) fail(`items[${i}]`, 'expected an object')
    const item = parseItem(it as Record<string, unknown>, `items[${i}]`, blobs, min, max)
    if (item) items.push(item)
  })
  return {
    id: pageId,
    kind: o.kind as 'sheet' | 'view',
    number: nullableStr(o.number, 'number'),
    name: nullableStr(o.name, 'name') ?? '',
    scale: nullableStr(o.scale, 'scale'),
    sizePt: { w: (max[0] - min[0]) * PT_PER_FT, h: (max[1] - min[1]) * PT_PER_FT },
    items,
  }
}

/** Parse a decompressed `.drawing` payload (magic, version, header, padding, buffer). */
export function parseLegacyDrawingPayload(payload: Uint8Array): DrawingDocument {
  if (payload.length < PREAMBLE) throw new DrawingFormatError(`not a .drawing payload: ${payload.length} bytes is shorter than the ${PREAMBLE}-byte preamble`)
  if (!isDrawingPayload(payload)) throw new DrawingFormatError('not a .drawing payload: bad magic (expected DRAWING\\0)')
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const version = dv.getUint32(8, true)
  if (version !== LEGACY_DRAWING_VERSION) throw new DrawingFormatError(`unsupported .drawing version ${version} (the editor reads version ${LEGACY_DRAWING_VERSION})`)
  const headerLen = dv.getUint32(12, true)
  const headerEnd = PREAMBLE + headerLen
  if (headerEnd > payload.length) throw new DrawingFormatError(`header length ${headerLen} runs past the end of the file (${payload.length} bytes)`)
  const bufferStart = (headerEnd + 3) & ~3
  if (bufferStart > payload.length) throw new DrawingFormatError('the file ends inside the padding after the header')

  let header: unknown
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(PREAMBLE, headerEnd)))
  } catch (e) {
    throw new DrawingFormatError(`header is not valid UTF-8 JSON: ${(e as Error).message}`)
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) throw new DrawingFormatError('header: expected a JSON object')
  const h = header as Record<string, unknown>
  if (h.format !== 'drawing') throw new DrawingFormatError(`header.format: expected "drawing", got ${JSON.stringify(h.format)}`)
  if (h.version !== undefined && h.version !== LEGACY_DRAWING_VERSION)
    throw new DrawingFormatError(`header.version ${JSON.stringify(h.version)} disagrees with the preamble version ${LEGACY_DRAWING_VERSION}`)
  if (!Array.isArray(h.pages)) throw new DrawingFormatError('header.pages: expected an array')

  const blobs = new Blobs(payload, bufferStart)
  const pages = h.pages.map((p, i) => {
    try {
      return parsePage(p, () => blobs)
    } catch (e) {
      if (e instanceof DrawingFormatError) throw new DrawingFormatError(`pages[${i}].${e.message}`)
      throw e
    }
  })
  // stable sort: sheets first, header order within a kind
  pages.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sheet' ? -1 : 1))

  const elements = (typeof h.elements === 'object' && h.elements !== null && !Array.isArray(h.elements) ? h.elements : {}) as Record<string, DrawingElement>
  const src = (typeof h.source === 'object' && h.source !== null ? h.source : {}) as Record<string, unknown>
  const source: DrawingDocument['source'] = {}
  if (typeof src.file === 'string') source.file = src.file
  if (typeof src.generator === 'string') source.generator = src.generator
  return { source, pages, elements }
}

/** "A102 Plans" for a sheet, "{3D} (view)" for a view (the viewer's page label). */
export function pageLabel(page: Pick<DrawingPage, 'id' | 'kind' | 'number' | 'name'>): string {
  if (page.kind === 'sheet') return [page.number, page.name].filter(Boolean).join(' ') || `Sheet ${page.id}`
  return `${page.name || `View ${page.id}`} (view)`
}
