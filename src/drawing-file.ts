// Reader for the binary .drawing format (spec: schema/drawing-format.md). No DOM.
// The file is a gzip stream of: magic, version, JSON header, padding, buffer of blobs. Geometry blobs become
// Float32Array views into the one decompressed buffer, so loading a page costs a JSON parse plus view creation.
import {
  num,
  pageBounds,
  parseItems,
  SceneError,
  type Coords,
  type ElementInfo,
  type GeometryReader,
  type Scene,
} from "./scene";

export const DRAWING_VERSION = 1;
const MAGIC = [0x44, 0x52, 0x41, 0x57, 0x49, 0x4e, 0x47, 0x00]; // "DRAWING\0"
const PREAMBLE = 16; // magic (8) + version (4) + header length (4)
const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class DrawingError extends Error {}

export interface DrawingPage {
  id: number;
  kind: "sheet" | "view";
  number: string | null;
  name: string;
  scale: string | null;
  /** The page in the viewer's scene model; `scene.elements` is the document's shared table. */
  scene: Scene;
}

export interface DrawingDoc {
  source: { file?: string; generator?: string };
  /** Sheets first, then views; the order the header lists them in is kept within each kind. */
  pages: DrawingPage[];
  elements: Record<string, ElementInfo>;
}

/** "A102 Plans" for a sheet, "{3D} (view)" for a view. */
export function pageLabel(page: Pick<DrawingPage, "id" | "kind" | "number" | "name">): string {
  if (page.kind === "sheet") return [page.number, page.name].filter(Boolean).join(" ") || `Sheet ${page.id}`;
  return `${page.name || `View ${page.id}`} (view)`;
}

/** A scene JSON file as a one-page document. */
export function sceneAsDoc(scene: Scene): DrawingDoc {
  const sheet = scene.sheet;
  const info = scene.viewInfo;
  const page: DrawingPage = sheet
    ? { id: sheet.id, kind: "sheet", number: sheet.number || null, name: sheet.name, scale: null, scene }
    : { id: info?.id ?? 0, kind: "view", number: null, name: info?.name ?? "Scene", scale: info ? String(info.scale) : null, scene };
  return { source: {}, pages: [page], elements: scene.elements };
}

// ---------- blobs ----------

class Blobs {
  /** `payload` is the whole decompressed file; the buffer is `payload[start..]`. */
  constructor(
    private payload: Uint8Array,
    private start: number,
  ) {}

  private get size(): number {
    return this.payload.length - this.start;
  }

  /** Validates a blob reference [byteOffset, byteLength] and returns it. */
  private ref(v: unknown, what: string, align: number): [number, number] {
    if (!Array.isArray(v) || v.length !== 2 || !Number.isInteger(v[0]) || !Number.isInteger(v[1]) || v[0] < 0 || v[1] < 0) {
      throw new DrawingError(`${what}: expected a blob reference [byteOffset, byteLength]`);
    }
    const [off, len] = v as [number, number];
    if (off + len > this.size) {
      throw new DrawingError(`${what}: blob [${off}, ${len}] is out of bounds (the buffer has ${this.size} bytes)`);
    }
    if (off % 4 !== 0) throw new DrawingError(`${what}: blob offset ${off} is not a multiple of 4`);
    if (len % align !== 0) throw new DrawingError(`${what}: blob length ${len} is not a multiple of ${align}`);
    return [off, len];
  }

  private floats(v: unknown, what: string, unit: number): Coords {
    const [off, len] = this.ref(v, what, unit * 4);
    const abs = this.payload.byteOffset + this.start + off;
    let out: Float32Array;
    if (LITTLE_ENDIAN_HOST && abs % 4 === 0) {
      out = new Float32Array(this.payload.buffer, abs, len / 4);
    } else {
      // Misaligned input (a subarray at an odd offset) or a big-endian host: decode a copy.
      out = new Float32Array(len / 4);
      const view = new DataView(this.payload.buffer, abs, len);
      for (let k = 0; k < out.length; k++) out[k] = view.getFloat32(4 * k, true);
    }
    for (let k = 0; k < out.length; k++) {
      if (!Number.isFinite(out[k])) throw new DrawingError(`${what}: coordinate ${k} is not a finite number`);
    }
    return out;
  }

  reader(): GeometryReader {
    return {
      points: (v, what) => this.floats(v, what, 2),
      segments: (v, what) => this.floats(v, what, 4),
      png: (v, what) => {
        // Not checked for a PNG signature: an image the browser cannot decode is not drawn, and does not stop the page loading.
        const [off, len] = this.ref(v, what, 1);
        return this.payload.subarray(this.start + off, this.start + off + len);
      },
    };
  }
}

// ---------- header ----------

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new DrawingError(`${what}: expected a string`);
  return v;
}

function nullableStr(v: unknown, what: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number") return String(v);
  return str(v, what);
}

/** Parses one page. Error messages name the field relative to the page; the caller adds `pages[i].`. */
function parsePage(raw: unknown, geo: GeometryReader, elements: Record<string, ElementInfo>): DrawingPage {
  if (typeof raw !== "object" || raw === null) throw new DrawingError("expected an object");
  const o = raw as Record<string, unknown>;
  if (o.kind !== "sheet" && o.kind !== "view") throw new DrawingError(`kind: expected "sheet" or "view", got ${JSON.stringify(o.kind)}`);
  const id = num(o.id, "id");
  const number = nullableStr(o.number, "number");
  const name = nullableStr(o.name, "name") ?? "";
  const scale = nullableStr(o.scale, "scale");
  const { min, max } = pageBounds(o.min, o.max);
  const items = parseItems(o.items, geo);
  const scene: Scene =
    o.kind === "sheet"
      ? { sheet: { id, number: number ?? "", name }, viewInfo: null, min, max, items, elements }
      : { sheet: null, viewInfo: { id, name, scale: scale ?? "" }, min, max, items, elements };
  return { id, kind: o.kind, number, name, scale, scene };
}

/** Parses a decompressed .drawing payload. */
export function parsePayload(payload: Uint8Array): DrawingDoc {
  if (payload.length < PREAMBLE) throw new DrawingError(`not a .drawing payload: ${payload.length} bytes is shorter than the ${PREAMBLE}-byte preamble`);
  if (MAGIC.some((b, k) => payload[k] !== b)) throw new DrawingError("not a .drawing payload: bad magic (expected DRAWING\\0)");
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = dv.getUint32(8, true);
  if (version !== DRAWING_VERSION) throw new DrawingError(`unsupported .drawing version ${version} (this viewer reads version ${DRAWING_VERSION})`);
  const headerLen = dv.getUint32(12, true);
  const headerEnd = PREAMBLE + headerLen;
  if (headerEnd > payload.length) throw new DrawingError(`header length ${headerLen} runs past the end of the file (${payload.length} bytes)`);
  const bufferStart = (headerEnd + 3) & ~3;
  if (bufferStart > payload.length) throw new DrawingError("the file ends inside the padding after the header");

  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(PREAMBLE, headerEnd)));
  } catch (e) {
    throw new DrawingError(`header is not valid UTF-8 JSON: ${(e as Error).message}`);
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) throw new DrawingError("header: expected a JSON object");
  const h = header as Record<string, unknown>;
  if (h.format !== "drawing") throw new DrawingError(`header.format: expected "drawing", got ${JSON.stringify(h.format)}`);
  if (h.version !== undefined && h.version !== DRAWING_VERSION) throw new DrawingError(`header.version ${JSON.stringify(h.version)} disagrees with the preamble version ${DRAWING_VERSION}`);
  if (!Array.isArray(h.pages)) throw new DrawingError("header.pages: expected an array");

  const elements = (typeof h.elements === "object" && h.elements !== null && !Array.isArray(h.elements) ? h.elements : {}) as Record<string, ElementInfo>;
  const geo = new Blobs(payload, bufferStart).reader();
  const pages = h.pages.map((p, i) => {
    try {
      return parsePage(p, geo, elements);
    } catch (e) {
      if (e instanceof DrawingError || e instanceof SceneError) throw new DrawingError(`pages[${i}].${e.message}`);
      throw e;
    }
  });
  pages.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "sheet" ? -1 : 1)); // stable: sheets first, header order within a kind

  const src = (typeof h.source === "object" && h.source !== null ? h.source : {}) as Record<string, unknown>;
  const source: DrawingDoc["source"] = {};
  if (typeof src.file === "string") source.file = src.file;
  if (typeof src.generator === "string") source.generator = src.generator;
  return { source, pages, elements };
}

// ---------- gzip ----------

export type Decompress = (gzip: Uint8Array) => Promise<Uint8Array>;

/** Decompresses a gzip stream with the platform's DecompressionStream (browsers and Node 18+). */
export const gunzip: Decompress = async (bytes) => {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new DrawingError("not a .drawing file: expected a gzip stream (it should start with bytes 1f 8b)");
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    throw new DrawingError(`could not decompress the gzip stream: ${(e as Error).message}`);
  }
};

/** Reads a .drawing file: gzip, then the payload. `decompress` is injectable so the parser can be tested without a platform codec. */
export async function parseDrawing(bytes: Uint8Array | ArrayBuffer, decompress: Decompress = gunzip): Promise<DrawingDoc> {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return parsePayload(await decompress(input));
}
