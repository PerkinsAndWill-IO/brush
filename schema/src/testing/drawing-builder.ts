// Test support: builds .drawing bytes from a header and blobs, following schema/drawing-format-legacy.md.
// Written separately from the reader on purpose, so the tests check the format and not the reader against itself.

/** Little-endian f32 bytes. */
export function f32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setFloat32(4 * i, v, true));
  return out;
}

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Collects blobs, each starting at a multiple of 4 from the buffer start. */
export class BlobBuffer {
  private parts: Uint8Array[] = [];
  private size = 0;

  add(bytes: Uint8Array): [number, number] {
    const at = this.size;
    this.parts.push(bytes);
    this.size += bytes.length;
    const pad = (4 - (this.size % 4)) % 4;
    if (pad) this.parts.push(new Uint8Array(pad));
    this.size += pad;
    return [at, bytes.length];
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Magic, version, header, zero padding to a multiple of 4, then the buffer. */
export function buildPayload(header: unknown, buffer: Uint8Array, opts: { magic?: string; version?: number } = {}): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const bufferStart = (16 + json.length + 3) & ~3;
  const out = new Uint8Array(bufferStart + buffer.length);
  out.set(new TextEncoder().encode(opts.magic ?? "DRAWING\0"), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, opts.version ?? 1, true);
  dv.setUint32(12, json.length, true);
  out.set(json, 16);
  out.set(buffer, bufferStart);
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
