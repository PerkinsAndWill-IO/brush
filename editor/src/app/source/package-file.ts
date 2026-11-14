/**
 * Reading legacy manifest packages (decision 0005). Pure and DOM-free: bytes in, manifest + optional PDF bytes out.
 * The `.drawing` format proper is the binary one in `schema/schema/drawing-format.md` (decision 0008, read by
 * `drawing-file.ts`); `sniffBytes` tells them apart by content. These manifest containers stay readable for the
 * M5 fixtures and older exports.
 *
 * Three container shapes, all carrying the same manifest (docs/decisions/0002):
 *  1. JSON envelope (what we write): the manifest at the top level plus `pdf: { name, encoding: 'base64', data }`.
 *  2. ZIP (what an Exporter may prefer): `manifest.json` plus one `*.pdf` (stored or deflate; zero-dep reader).
 *  3. Bare manifest JSON, optionally `pdf: { href }` (linked PDF, relative to the package).
 * The reader is tolerant (unknown keys ignored, missing arrays default to empty); only a missing/invalid
 * `sheets` list or an unsupported schemaVersion is an error.
 */
import { DRAWING_MANIFEST_VERSION, type DrawingManifest, type ManifestElement, type ManifestSheet } from '@core/context'
import { isDrawingPayload, isGzip } from '@core/drawing'
import type { Point } from '@core/types'

export class PackageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackageError'
  }
}

export interface PackagePdfRef {
  name?: string
  /** Embedded PDF bytes (envelope base64 or zip entry). */
  bytes?: Uint8Array
  /** Linked PDF (bare manifest). */
  href?: string
}

export interface ParsedPackage {
  manifest: DrawingManifest
  pdf: PackagePdfRef | null
  container: 'json' | 'zip'
}

/** `drawing` is the binary `.drawing` format (gzip, or an already decompressed payload; decision 0008). */
export type SniffedType = 'pdf' | 'drawing' | 'package-json' | 'package-zip' | 'unknown'

const ascii = (b: Uint8Array, from: number, len: number): string => String.fromCharCode(...b.subarray(from, from + len))

/** Decide what a file is from its first bytes (extension is only the tie-break for JSON). */
export function sniffBytes(bytes: Uint8Array, name = ''): SniffedType {
  if (isGzip(bytes) || isDrawingPayload(bytes)) return 'drawing'
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) return 'package-zip'
  if (ascii(bytes, 0, Math.min(bytes.length, 1024)).includes('%PDF-')) return 'pdf'
  let i = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++
  if (bytes[i] === 0x7b) return 'package-json'
  if (/\.drawing$/i.test(name) && bytes.length) return 'package-json'
  return 'unknown'
}

const isPoint = (p: unknown): p is Point => !!p && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number'

function normaliseElement(e: unknown): ManifestElement | null {
  const o = e as Partial<ManifestElement> | null
  if (!o || (typeof o.id !== 'string' && typeof o.id !== 'number') || typeof o.category !== 'string') return null
  const el: ManifestElement = {
    id: String(o.id),
    category: o.category,
    footprint: Array.isArray(o.footprint) ? o.footprint.filter(isPoint).map((p) => ({ x: p.x, y: p.y })) : [],
  }
  if (typeof o.closed === 'boolean') el.closed = o.closed
  if (typeof o.typeName === 'string') el.typeName = o.typeName
  if (typeof o.label === 'string') el.label = o.label
  if (o.props && typeof o.props === 'object') el.props = { ...o.props }
  return el
}

/** Validate and normalise a manifest object (extra keys such as `pdf` are dropped). */
export function parseManifest(json: unknown): DrawingManifest {
  const o = json as Record<string, unknown> | null
  if (!o || typeof o !== 'object') throw new PackageError('manifest is not an object')
  if (o.schemaVersion !== DRAWING_MANIFEST_VERSION) throw new PackageError(`unsupported manifest schemaVersion ${String(o.schemaVersion)}`)
  if (!Array.isArray(o.sheets)) throw new PackageError('manifest has no sheets list')
  const sheets: ManifestSheet[] = o.sheets.map((s, i) => {
    const sh = s as Partial<ManifestSheet> | null
    const size = sh?.sizePt
    if (!sh || typeof sh.id !== 'string' || !size || typeof size.w !== 'number' || typeof size.h !== 'number')
      throw new PackageError(`sheet ${i} needs id and sizePt`)
    const out: ManifestSheet = {
      id: sh.id,
      name: typeof sh.name === 'string' ? sh.name : sh.id,
      sizePt: { w: size.w, h: size.h },
      elements: (Array.isArray(sh.elements) ? sh.elements : []).map(normaliseElement).filter((x): x is ManifestElement => x !== null),
    }
    if (typeof sh.number === 'string') out.number = sh.number
    if (typeof sh.scale === 'number') out.scale = sh.scale
    return out
  })
  const manifest: DrawingManifest = { schemaVersion: DRAWING_MANIFEST_VERSION, sheets }
  if (typeof o.project === 'string') manifest.project = o.project
  if (o.palette && typeof o.palette === 'object') manifest.palette = o.palette as DrawingManifest['palette']
  return manifest
}

export function decodeBase64(data: string): Uint8Array {
  const bin = atob(data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function encodeBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function pdfRefOf(raw: unknown): PackagePdfRef | null {
  const p = raw as { name?: unknown; encoding?: unknown; data?: unknown; href?: unknown } | null
  if (!p || typeof p !== 'object') return null
  const ref: PackagePdfRef = {}
  if (typeof p.name === 'string') ref.name = p.name
  if (typeof p.data === 'string' && (p.encoding === undefined || p.encoding === 'base64')) ref.bytes = decodeBase64(p.data)
  else if (typeof p.href === 'string') ref.href = p.href
  return ref.bytes || ref.href ? ref : null
}

function parseJsonPackage(bytes: Uint8Array): ParsedPackage {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    throw new PackageError('package is not valid JSON')
  }
  return { manifest: parseManifest(json), pdf: pdfRefOf(json.pdf), container: 'json' }
}

// ───────────────────────────── minimal ZIP reader ─────────────────────────────

interface ZipEntry {
  name: string
  method: number
  compSize: number
  localOffset: number
}

function readZipDirectory(b: Uint8Array): ZipEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new PackageError('zip: end of central directory not found')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new PackageError('zip: bad central directory')
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    entries.push({
      method: dv.getUint16(p + 10, true),
      compSize: dv.getUint32(p + 20, true),
      localOffset: dv.getUint32(p + 42, true),
      name: new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new PackageError('zip: deflate needs DecompressionStream')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function zipEntryBytes(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (dv.getUint32(e.localOffset, true) !== 0x04034b50) throw new PackageError('zip: bad local header')
  const start = e.localOffset + 30 + dv.getUint16(e.localOffset + 26, true) + dv.getUint16(e.localOffset + 28, true)
  const raw = b.subarray(start, start + e.compSize)
  if (e.method === 0) return raw
  if (e.method === 8) return inflateRaw(raw)
  throw new PackageError(`zip: unsupported compression method ${e.method}`)
}

async function parseZipPackage(bytes: Uint8Array): Promise<ParsedPackage> {
  const entries = readZipDirectory(bytes)
  const base = (n: string) => n.slice(n.lastIndexOf('/') + 1).toLowerCase()
  const mEntry = entries.find((e) => base(e.name) === 'manifest.json') ?? entries.find((e) => base(e.name) === 'drawing.json')
  if (!mEntry) throw new PackageError('zip: no manifest.json')
  const json = JSON.parse(new TextDecoder().decode(await zipEntryBytes(bytes, mEntry))) as Record<string, unknown>
  const manifest = parseManifest(json)
  const declared = (json.pdf as { path?: unknown } | undefined)?.path
  const pEntry =
    (typeof declared === 'string' ? entries.find((e) => e.name === declared || base(e.name) === base(declared)) : undefined) ??
    entries.find((e) => base(e.name).endsWith('.pdf'))
  const pdf: PackagePdfRef | null = pEntry ? { name: base(pEntry.name), bytes: await zipEntryBytes(bytes, pEntry) } : pdfRefOf(json.pdf)
  return { manifest, pdf, container: 'zip' }
}

/** Parse the bytes of a `.drawing` file (JSON envelope or ZIP). Throws PackageError. */
export async function parsePackage(bytes: Uint8Array): Promise<ParsedPackage> {
  const type = sniffBytes(bytes)
  if (type === 'package-zip') return parseZipPackage(bytes)
  if (type === 'package-json') return parseJsonPackage(bytes)
  throw new PackageError('not a drawing package')
}

/** Serialise the JSON envelope (used by the fixture generator and tests). */
export function serializePackage(manifest: DrawingManifest, pdf?: { name: string; bytes: Uint8Array }): string {
  const env: Record<string, unknown> = { ...manifest }
  if (pdf) env.pdf = { name: pdf.name, encoding: 'base64', data: encodeBase64(pdf.bytes) }
  return JSON.stringify(env)
}
