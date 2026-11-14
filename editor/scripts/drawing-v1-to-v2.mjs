#!/usr/bin/env node
// Converts a version 1 `.drawing` file to version 2 (specs: schema/schema/drawing-format.md and drawing-format-v2.md):
//
//   node scripts/drawing-v1-to-v2.mjs in.drawing [out.drawing] [--level 19]
//
// Default output: the input name with `-v2` before the extension. Default zstd level: 19 (needs Node 22.15+, which has
// zstd in node:zlib). Coordinates are rounded to a unit (0.01 mm of paper) before delta coding, and each delta is taken
// from the previous rounded value, so rounding errors do not accumulate. Every page gets its own frame, the elements
// table another, and each page frame carries per-element boxes. Text items are copied unchanged.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { constants, gunzipSync, zstdCompressSync } from 'node:zlib'

const UNITS_PER_FOOT = 30480
const PREAMBLE = 16
const MAGIC = Buffer.from('DRAWING\0', 'latin1')
const I32 = { min: -2147483648, max: 2147483647 }

function readV1(bytes) {
  let b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b)
  if (!b.subarray(0, 8).equals(MAGIC)) throw new Error('not a .drawing file: bad magic')
  const version = b.readUInt32LE(8)
  if (version !== 1) throw new Error(`expected a version 1 file, got version ${version}`)
  const headerLen = b.readUInt32LE(12)
  const header = JSON.parse(b.subarray(PREAMBLE, PREAMBLE + headerLen).toString('utf8'))
  const start = (PREAMBLE + headerLen + 3) & ~3
  return { header, buffer: b.subarray(start) }
}

const pad4 = (n) => (4 - (n % 4)) % 4

/** Collects a page frame's blobs, each starting at a multiple of 4; the same source blob is stored once. */
class FrameBlobs {
  parts = []
  size = 0
  seen = new Map()
  add(bytes) {
    const at = this.size
    this.parts.push(bytes, Buffer.alloc(pad4(bytes.length)))
    this.size += bytes.length + pad4(bytes.length)
    return [at, bytes.length]
  }
  once(key, make) {
    if (!this.seen.has(key)) this.seen.set(key, this.add(make()))
    return this.seen.get(key)
  }
}

function toUnits(v, origin, what) {
  const u = Math.round((v - origin) * UNITS_PER_FOOT)
  if (!Number.isFinite(u) || u < I32.min || u > I32.max) throw new Error(`${what}: coordinate ${v} does not fit 32-bit units`)
  return u
}

/** One page: the frame bytes (uncompressed) and the page's header entry. */
function convertPage(page, buffer, pageIdx) {
  const [minX, minY] = page.min
  const blobs = new FrameBlobs()
  const boxes = new Map()
  const boundsOf = new Map()
  const grow = (el, x0, y0, x1, y1) => {
    if (el === null || el === undefined) return
    const k = String(el)
    const b = boxes.get(k)
    if (!b) boxes.set(k, [x0, y0, x1, y1])
    else {
      b[0] = Math.min(b[0], x0)
      b[1] = Math.min(b[1], y0)
      b[2] = Math.max(b[2], x1)
      b[3] = Math.max(b[3], y1)
    }
  }
  const at = (what) => `pages[${pageIdx}].${what}`

  /** f32 blob -> delta-coded i32 blob; also returns the bounds of the quantised values. */
  const coords = (ref, kind, what) => {
    const [off, len] = ref
    const key = `${kind}:${off},${len}`
    const out = blobs.once(key, () => {
      const per = kind === 'segs' ? 4 : 2
      const n = len / 4
      if (len % (per * 4) !== 0) throw new Error(`${at(what)}: blob length ${len} is not a multiple of ${per * 4}`)
      const src = new DataView(buffer.buffer, buffer.byteOffset + off, len)
      const dst = Buffer.alloc(len)
      let px = 0
      let py = 0
      let ex = 0
      let ey = 0
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (let k = 0; k < n; k += per) {
        if (kind === 'segs') {
          const sx = toUnits(src.getFloat32(4 * k, true), minX, at(what))
          const sy = toUnits(src.getFloat32(4 * k + 4, true), minY, at(what))
          const tx = toUnits(src.getFloat32(4 * k + 8, true), minX, at(what))
          const ty = toUnits(src.getFloat32(4 * k + 12, true), minY, at(what))
          dst.writeInt32LE(sx - ex, 4 * k)
          dst.writeInt32LE(sy - ey, 4 * k + 4)
          dst.writeInt32LE(tx - sx, 4 * k + 8)
          dst.writeInt32LE(ty - sy, 4 * k + 12)
          ex = tx
          ey = ty
          x0 = Math.min(x0, sx, tx)
          y0 = Math.min(y0, sy, ty)
          x1 = Math.max(x1, sx, tx)
          y1 = Math.max(y1, sy, ty)
        } else {
          const x = toUnits(src.getFloat32(4 * k, true), minX, at(what))
          const y = toUnits(src.getFloat32(4 * k + 4, true), minY, at(what))
          dst.writeInt32LE(x - px, 4 * k)
          dst.writeInt32LE(y - py, 4 * k + 4)
          px = x
          py = y
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x)
          y1 = Math.max(y1, y)
        }
      }
      boundsOf.set(key, n ? [x0, y0, x1, y1] : null)
      return dst
    })
    return { ref: out, bounds: boundsOf.get(key) }
  }

  const items = page.items.map((it, i) => {
    const w = (f) => `items[${i}].${f}`
    switch (it.t) {
      case 'path': {
        const c = coords(it.pts, 'pts', w('pts'))
        if (c.bounds) grow(it.el, ...c.bounds)
        return { ...it, pts: c.ref }
      }
      case 'segs': {
        const c = coords(it.segs, 'segs', w('segs'))
        if (c.bounds) grow(it.el, ...c.bounds)
        return { ...it, segs: c.ref }
      }
      case 'fill': {
        const rings = it.rings.map((r, k) => {
          const c = coords(r, 'pts', w(`rings[${k}]`))
          if (c.bounds) grow(it.el, ...c.bounds)
          return c.ref
        })
        return { ...it, rings }
      }
      case 'image': {
        grow(it.el, toUnits(it.min[0], minX, w('min')), toUnits(it.min[1], minY, w('min')), toUnits(it.max[0], minX, w('max')), toUnits(it.max[1], minY, w('max')))
        const [off, len] = it.png
        return { ...it, png: blobs.once(`png:${off},${len}`, () => Buffer.from(buffer.subarray(off, off + len))) }
      }
      default:
        return it // text and unknown types are copied unchanged
    }
  })

  const json = Buffer.from(JSON.stringify({ items, boxes: Object.fromEntries(boxes) }), 'utf8')
  const head = Buffer.alloc(4 + json.length + pad4(4 + json.length))
  head.writeUInt32LE(json.length, 0)
  json.copy(head, 4)
  const { items: _items, ...entry } = page
  return { frame: Buffer.concat([head, ...blobs.parts]), entry }
}

/**
 * Convert the bytes of a version 1 file (gzip or raw) to a version 2 file.
 * @param {Uint8Array} bytes
 * @param {{ level?: number }} [opts]
 * @returns {Buffer}
 */
export function convertV1ToV2(bytes, { level = 19 } = {}) {
  const { header, buffer } = readV1(bytes)
  const compress = (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: level } })
  const frames = []
  const pages = header.pages.map((p, i) => {
    const { frame, entry } = convertPage(p, buffer, i)
    frames.push(compress(frame))
    return entry
  })
  frames.push(compress(Buffer.from(JSON.stringify(header.elements ?? {}), 'utf8')))

  // Frame offsets depend on the header length, which depends on the offsets: pad the JSON with spaces until it settles.
  const build = (len) => {
    let at = PREAMBLE + len
    const refs = frames.map((f) => {
      const r = [at, f.length]
      at += f.length
      return r
    })
    const h = {
      format: 'drawing',
      version: 2,
      source: header.source,
      unitsPerFoot: UNITS_PER_FOOT,
      pages: pages.map((p, i) => ({ ...p, frame: refs[i] })),
      elements: refs[pages.length],
    }
    return Buffer.from(JSON.stringify(h), 'utf8')
  }
  let len = 0
  let json = build(len)
  while (json.length > len) {
    len = json.length
    json = build(len)
  }
  const out = Buffer.alloc(PREAMBLE + len)
  MAGIC.copy(out, 0)
  out.writeUInt32LE(2, 8)
  out.writeUInt32LE(len, 12)
  out.fill(0x20, PREAMBLE) // trailing spaces are valid JSON
  json.copy(out, PREAMBLE)
  return Buffer.concat([out, ...frames])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  let level = 19
  const li = args.indexOf('--level')
  if (li >= 0) level = Number(args.splice(li, 2)[1])
  const [input, output = input.replace(/(\.drawing)?$/i, '-v2.drawing')] = args
  if (!input || !Number.isInteger(level)) {
    console.error('usage: node scripts/drawing-v1-to-v2.mjs in.drawing [out.drawing] [--level 19]')
    process.exit(2)
  }
  const t0 = performance.now()
  const src = readFileSync(input)
  const out = convertV1ToV2(src, { level })
  writeFileSync(output, out)
  console.log(`${input} (${src.length} bytes) -> ${output} (${out.length} bytes, ${((100 * out.length) / src.length).toFixed(1)}%) at zstd level ${level} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}
