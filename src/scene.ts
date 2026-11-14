// Scene JSON contract: parsing and validation. No DOM.
// Coordinates are paper feet, y up. Parsed items keep points in flat Float64Arrays.

export type Rgb = [number, number, number];

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
  xy: Float64Array; // x0,y0,x1,y1,...
  closed: boolean;
  w: number;
  c: Rgb;
  dash: number[];
}

export interface SegsItem extends Common {
  t: "segs";
  xy: Float64Array; // x0,y0,x1,y1 per segment
  w: number;
  c: Rgb;
  dash: number[];
}

export interface FillItem extends Common {
  t: "fill";
  rings: Float64Array[]; // each ring x0,y0,x1,y1,...
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
  png: string;
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

class SceneError extends Error {}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new SceneError(`${what}: expected a number`);
  return v;
}

function pair(v: unknown, what: string): [number, number] {
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

function flatPoints(v: unknown, what: string): Float64Array {
  if (!Array.isArray(v)) throw new SceneError(`${what}: expected a list of points`);
  const out = new Float64Array(v.length * 2);
  for (let i = 0; i < v.length; i++) {
    const p = v[i];
    if (!Array.isArray(p) || p.length < 2) throw new SceneError(`${what}[${i}]: expected [x, y]`);
    out[2 * i] = num(p[0], what);
    out[2 * i + 1] = num(p[1], what);
  }
  return out;
}

function dashList(v: unknown, what: string): number[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SceneError(`${what}: expected a list`);
  return v.map((d) => num(d, what));
}

function parseItem(raw: unknown, i: number): Item | null {
  if (typeof raw !== "object" || raw === null) throw new SceneError(`items[${i}]: expected an object`);
  const o = raw as Record<string, unknown>;
  const at = `items[${i}]`;
  const common = { el: nullableId(o.el, `${at}.el`), view: nullableId(o.view, `${at}.view`) };
  switch (o.t) {
    case "path":
      return {
        t: "path",
        xy: flatPoints(o.pts, `${at}.pts`),
        closed: o.closed === true,
        w: num(o.w, `${at}.w`),
        c: rgb(o.c, `${at}.c`),
        dash: dashList(o.dash, `${at}.dash`),
        ...common,
      };
    case "segs": {
      if (!Array.isArray(o.segs)) throw new SceneError(`${at}.segs: expected a flat number array`);
      if (o.segs.length % 4 !== 0) throw new SceneError(`${at}.segs: length must be a multiple of 4`);
      const xy = new Float64Array(o.segs.length);
      for (let k = 0; k < xy.length; k++) xy[k] = num(o.segs[k], `${at}.segs`);
      return { t: "segs", xy, w: num(o.w, `${at}.w`), c: rgb(o.c, `${at}.c`), dash: dashList(o.dash, `${at}.dash`), ...common };
    }
    case "fill": {
      if (!Array.isArray(o.rings)) throw new SceneError(`${at}.rings: expected a list of rings`);
      return { t: "fill", rings: o.rings.map((r, k) => flatPoints(r, `${at}.rings[${k}]`)), c: rgb(o.c, `${at}.c`), ...common };
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
      if (typeof o.png !== "string") throw new SceneError(`${at}.png: expected a base64 string`);
      return { t: "image", min: pair(o.min, `${at}.min`), max: pair(o.max, `${at}.max`), png: o.png, ...common };
    default:
      return null; // unknown item types are skipped so a newer exporter does not break the viewer
  }
}

/** Validates a parsed JSON value against the contract. Throws an Error with a readable message. */
export function parseScene(json: unknown): Scene {
  if (typeof json !== "object" || json === null) throw new SceneError("scene: expected a JSON object");
  const o = json as Record<string, unknown>;
  if (o.format !== 1) throw new SceneError(`scene: unsupported format ${JSON.stringify(o.format)} (expected 1)`);
  const min = pair(o.min, "min");
  const max = pair(o.max, "max");
  if (!(max[0] > min[0]) || !(max[1] > min[1])) throw new SceneError("scene: max must be greater than min");
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

  const items: Item[] = [];
  for (let i = 0; i < o.items.length; i++) {
    const item = parseItem(o.items[i], i);
    if (item) items.push(item);
  }
  const elements = (typeof o.elements === "object" && o.elements !== null ? o.elements : {}) as Record<string, ElementInfo>;
  return { sheet, viewInfo, min, max, items, elements };
}

export function sceneTitle(scene: Scene): string {
  if (scene.sheet) return `${scene.sheet.number} ${scene.sheet.name}`.trim();
  if (scene.viewInfo) return scene.viewInfo.name;
  return "Scene";
}
