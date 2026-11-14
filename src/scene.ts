// Scene model and the scene JSON contract: parsing and validation. No DOM.
// Coordinates are paper feet, y up. Parsed items keep points in flat typed arrays: Float64Array when they come from
// JSON, Float32Array views straight into the file buffer when they come from a .drawing (see drawing-file.ts).

export type Rgb = [number, number, number];

/** Flat x,y coordinates. */
export type Coords = Float32Array | Float64Array;

export interface ElementInfo {
  class?: string;
  category?: string | null;
  name?: string;
  family?: string;
  type?: string;
  level?: string;
  /** Set on tags: the element the tag labels. */
  tagged?: number | null;
  params?: { name: string; value: string }[];
}

interface Common {
  el: number | null;
  view: number | null;
}

export interface PathItem extends Common {
  t: "path";
  xy: Coords; // x0,y0,x1,y1,...
  closed: boolean;
  w: number;
  c: Rgb;
  dash: number[];
}

export interface SegsItem extends Common {
  t: "segs";
  xy: Coords; // x0,y0,x1,y1 per segment
  w: number;
  c: Rgb;
  dash: number[];
}

export interface FillItem extends Common {
  t: "fill";
  rings: Coords[]; // each ring x0,y0,x1,y1,...
  c: Rgb;
}

export interface TextItem extends Common {
  t: "text";
  text: string;
  at: [number, number];
  size: number;
  anchor: string;
  dir: [number, number];
  maxWidth: number | null;
  c: Rgb;
  bold: boolean;
}

export interface ImageItem extends Common {
  t: "image";
  min: [number, number];
  max: [number, number];
  /** PNG file bytes. */
  png: Uint8Array;
}

export type Item = PathItem | SegsItem | FillItem | TextItem | ImageItem;

export interface Scene {
  sheet: { id: number; number: string; name: string } | null;
  viewInfo: { id: number; name: string; scale: number | string } | null;
  min: [number, number];
  max: [number, number];
  items: Item[];
  elements: Record<string, ElementInfo>;
}

export class SceneError extends Error {}

export function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new SceneError(`${what}: expected a number`);
  return v;
}

export function pair(v: unknown, what: string): [number, number] {
  if (!Array.isArray(v) || v.length < 2) throw new SceneError(`${what}: expected [x, y]`);
  return [num(v[0], what), num(v[1], what)];
}

function rgb(v: unknown, what: string): Rgb {
  if (v === undefined || v === null) return [0, 0, 0];
  if (!Array.isArray(v) || v.length < 3) throw new SceneError(`${what}: expected [r, g, b]`);
  return [num(v[0], what), num(v[1], what), num(v[2], what)];
}

function nullableId(v: unknown, what: string): number | null {
  if (v === undefined || v === null) return null;
  return num(v, what);
}

function dashList(v: unknown, what: string): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SceneError(`${what}: expected a list`);
  return v.map((d) => num(d, what));
}

/**
 * Where an item's bulk data lives. The scene JSON inlines it (nested number lists, base64); a .drawing stores
 * it as blob references into the file buffer. Items are otherwise identical, so one parser serves both.
 */
export interface GeometryReader {
  /** `path.pts` and each ring of `fill.rings`: flat x,y pairs. */
  points(v: unknown, what: string): Coords;
  /** `segs.segs`: flat x0,y0,x1,y1 per segment. */
  segments(v: unknown, what: string): Coords;
  /** `image.png`: PNG file bytes. */
  png(v: unknown, what: string): Uint8Array;
}

export const jsonGeometry: GeometryReader = {
  points(v, what) {
    if (!Array.isArray(v)) throw new SceneError(`${what}: expected a list of points`);
    const out = new Float64Array(v.length * 2);
    for (let i = 0; i < v.length; i++) {
      const p = v[i];
      if (!Array.isArray(p) || p.length < 2) throw new SceneError(`${what}[${i}]: expected [x, y]`);
      out[2 * i] = num(p[0], what);
      out[2 * i + 1] = num(p[1], what);
    }
    return out;
  },
  segments(v, what) {
    if (!Array.isArray(v)) throw new SceneError(`${what}: expected a flat number array`);
    if (v.length % 4 !== 0) throw new SceneError(`${what}: length must be a multiple of 4`);
    const xy = new Float64Array(v.length);
    for (let k = 0; k < xy.length; k++) xy[k] = num(v[k], what);
    return xy;
  },
  png(v, what) {
    if (typeof v !== "string") throw new SceneError(`${what}: expected a base64 string`);
    const bin = atob(v);
    const bytes = new Uint8Array(bin.length);
    for (let b = 0; b < bin.length; b++) bytes[b] = bin.charCodeAt(b);
    return bytes;
  },
};

/** Parses one item; returns null for an unknown item type. */
export function parseItem(raw: unknown, i: number, geo: GeometryReader): Item | null {
  if (typeof raw !== "object" || raw === null) throw new SceneError(`items[${i}]: expected an object`);
  const o = raw as Record<string, unknown>;
  const at = `items[${i}]`;
  const common = { el: nullableId(o.el, `${at}.el`), view: nullableId(o.view, `${at}.view`) };
  switch (o.t) {
    case "path":
      return {
        t: "path",
        xy: geo.points(o.pts, `${at}.pts`),
        closed: o.closed === true,
        w: num(o.w, `${at}.w`),
        c: rgb(o.c, `${at}.c`),
        dash: dashList(o.dash, `${at}.dash`),
        ...common,
      };
    case "segs":
      return { t: "segs", xy: geo.segments(o.segs, `${at}.segs`), w: num(o.w, `${at}.w`), c: rgb(o.c, `${at}.c`), dash: dashList(o.dash, `${at}.dash`), ...common };
    case "fill": {
      if (!Array.isArray(o.rings)) throw new SceneError(`${at}.rings: expected a list of rings`);
      return { t: "fill", rings: o.rings.map((r, k) => geo.points(r, `${at}.rings[${k}]`)), c: rgb(o.c, `${at}.c`), ...common };
    }
    case "text": {
      if (typeof o.text !== "string") throw new SceneError(`${at}.text: expected a string`);
      const dir = o.dir === undefined || o.dir === null ? ([1, 0] as [number, number]) : pair(o.dir, `${at}.dir`);
      const len = Math.hypot(dir[0], dir[1]);
      const anchor = typeof o.anchor === "string" && /^[lcr][tmb]$/.test(o.anchor) ? o.anchor : "lb";
      return {
        t: "text",
        text: o.text,
        at: pair(o.at, `${at}.at`),
        size: num(o.size, `${at}.size`),
        anchor,
        dir: len > 0 ? [dir[0] / len, dir[1] / len] : [1, 0],
        maxWidth: o.maxWidth === undefined || o.maxWidth === null ? null : num(o.maxWidth, `${at}.maxWidth`),
        c: rgb(o.c, `${at}.c`),
        bold: o.bold === true,
        ...common,
      };
    }
    case "image":
      return { t: "image", min: pair(o.min, `${at}.min`), max: pair(o.max, `${at}.max`), png: geo.png(o.png, `${at}.png`), ...common };
    default:
      return null; // unknown item types are skipped so a newer exporter does not break the viewer
  }
}

/** Parses an items array, dropping unknown item types. */
export function parseItems(raw: unknown, geo: GeometryReader): Item[] {
  if (!Array.isArray(raw)) throw new SceneError("items must be an array");
  const items: Item[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = parseItem(raw[i], i, geo);
    if (item) items.push(item);
  }
  return items;
}

/** The page rectangle, which must have an area. */
export function pageBounds(minRaw: unknown, maxRaw: unknown): { min: [number, number]; max: [number, number] } {
  const min = pair(minRaw, "min");
  const max = pair(maxRaw, "max");
  if (!(max[0] > min[0]) || !(max[1] > min[1])) throw new SceneError("max must be greater than min");
  return { min, max };
}

/** Validates a parsed JSON value against the contract. Throws an Error with a readable message. */
export function parseScene(json: unknown): Scene {
  if (typeof json !== "object" || json === null) throw new SceneError("scene: expected a JSON object");
  const o = json as Record<string, unknown>;
  if (o.format !== 1) throw new SceneError(`scene: unsupported format ${JSON.stringify(o.format)} (expected 1)`);
  const { min, max } = pageBounds(o.min, o.max);
  if (!Array.isArray(o.items)) throw new SceneError("scene: items must be an array");

  let sheet: Scene["sheet"] = null;
  if (o.sheet !== null && o.sheet !== undefined) {
    const s = o.sheet as Record<string, unknown>;
    sheet = { id: num(s.id, "sheet.id"), number: String(s.number ?? ""), name: String(s.name ?? "") };
  }
  let viewInfo: Scene["viewInfo"] = null;
  if (o.viewInfo !== null && o.viewInfo !== undefined) {
    const v = o.viewInfo as Record<string, unknown>;
    viewInfo = { id: num(v.id, "viewInfo.id"), name: String(v.name ?? ""), scale: typeof v.scale === "number" ? v.scale : String(v.scale ?? "") };
  }

  const items = parseItems(o.items, jsonGeometry);
  const elements = (typeof o.elements === "object" && o.elements !== null ? o.elements : {}) as Record<string, ElementInfo>;
  return { sheet, viewInfo, min, max, items, elements };
}

export function sceneTitle(scene: Scene): string {
  if (scene.sheet) return `${scene.sheet.number} ${scene.sheet.name}`.trim();
  if (scene.viewInfo) return scene.viewInfo.name;
  return "Scene";
}
