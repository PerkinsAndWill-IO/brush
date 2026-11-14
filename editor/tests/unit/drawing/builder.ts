/**
 * Test support: builds version 2 `.drawing` bytes by hand from literal integer blobs, following
 * schema/schema/drawing-format-v2.md. Written separately from the reader and from the converter script.
 */
import { constants, zstdCompressSync } from 'node:zlib'

export const zstd = (bytes: Uint8Array, level = 3): Buffer => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: level } })

/** i32 little-endian values (already delta-coded by the caller). */
export function i32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const dv = new DataView(out.buffer)
  values.forEach((v, i) => dv.setInt32(4 * i, v, true))
  return out
}

/** The uncompressed page frame: u32 J, page JSON, padding to 4, buffer. */
export function pageFrame(json: unknown, buffer: Uint8Array): Uint8Array {
  const j = new TextEncoder().encode(JSON.stringify(json))
  const start = (4 + j.length + 3) & ~3
  const out = new Uint8Array(start + buffer.length)
  new DataView(out.buffer).setUint32(0, j.length, true)
  out.set(j, 4)
  out.set(buffer, start)
  return out
}

export interface V2Page {
  /** Header fields without `items` and `frame`. */
  entry: Record<string, unknown>
  /** The compressed frame bytes (default: zstd of `frame`). */
  bytes?: Uint8Array
  frame?: Uint8Array
  /** Overrides the frame reference. */
  ref?: [number, number]
}

/** Raw magic, version, header, then the frames. `elements` is the elements table's JSON (or raw frame bytes). */
export function buildV2(
  pages: V2Page[],
  elements: unknown,
  opts: { unitsPerFoot?: number | null; elementsRef?: [number, number]; magic?: string; version?: number; headerVersion?: number } = {},
): Uint8Array {
  const frames = pages.map((p) => p.bytes ?? zstd(p.frame ?? new Uint8Array()))
  frames.push(elements instanceof Uint8Array ? elements : zstd(new TextEncoder().encode(JSON.stringify(elements))))
  const header = (len: number) => {
    let at = 16 + len
    const refs = frames.map((f) => {
      const r: [number, number] = [at, f.length]
      at += f.length
      return r
    })
    const h: Record<string, unknown> = {
      format: 'drawing',
      version: opts.headerVersion ?? 2,
      source: { file: 'model.rvt', generator: 'test' },
      pages: pages.map((p, i) => ({ ...p.entry, frame: p.ref ?? refs[i] })),
      elements: opts.elementsRef ?? refs[pages.length],
    }
    if (opts.unitsPerFoot !== null) h.unitsPerFoot = opts.unitsPerFoot ?? 30480
    return new TextEncoder().encode(JSON.stringify(h))
  }
  let len = 0
  while (header(len).length > len) len = header(len).length
  const json = header(len)
  const out = new Uint8Array(16 + len + frames.reduce((n, f) => n + f.length, 0))
  out.set(new TextEncoder().encode(opts.magic ?? 'DRAWING\0'), 0)
  const dv = new DataView(out.buffer)
  dv.setUint32(8, opts.version ?? 2, true)
  dv.setUint32(12, len, true)
  out.fill(0x20, 16, 16 + len)
  out.set(json, 16)
  let at = 16 + len
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}
