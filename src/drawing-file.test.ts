import { describe, expect, it } from "vitest";
import { DrawingError, pageLabel, parseDrawing, parsePayload } from "./drawing-file";
import { BlobBuffer, buildPayload, f32, gzip, PNG_BYTES } from "./testing/drawing-builder";

/** Two pages, deliberately listed view first, sharing one element table. */
function sample() {
  const buf = new BlobBuffer();
  const pts = buf.add(f32(0, 0, 1.5, 0.5, 2, 1));
  const segs = buf.add(f32(0, 0, 1, 1, 2, 2, 3, 3));
  const ring = buf.add(f32(0, 0, 1, 0, 1, 1, 0, 1));
  const png = buf.add(PNG_BYTES);
  const header = {
    format: "drawing",
    version: 1,
    source: { file: "model.rvt", generator: "test" },
    pages: [
      {
        id: 960621, kind: "view", number: null, name: "{3D}", scale: "1 : 100", min: [0, 0], max: [4, 3],
        items: [{ t: "segs", segs, w: 0.001, c: [1, 2, 3], dash: [], el: 12, view: 960621 }],
      },
      {
        id: 382617, kind: "sheet", number: "A102", name: "Plans", scale: null, min: [0, 0], max: [2.76, 1.95],
        items: [
          { t: "path", pts, closed: true, w: 0.0006, c: [0, 0, 0], dash: [0.01, 0.02], el: 12, view: 5 },
          { t: "fill", rings: [ring], c: [200, 200, 200], el: null, view: null },
          { t: "text", text: "Kitchen", at: [1, 1], size: 0.008, anchor: "cm", dir: [1, 0], maxWidth: null, c: [0, 0, 0], bold: false, el: 13, view: 5 },
          { t: "image", min: [0, 0], max: [1, 1], png, el: null, view: null },
          { t: "hatch" },
        ],
      },
    ],
    elements: { "12": { class: "Wall", category: "Walls", name: "Basic Wall", params: [{ name: "Area", value: "12.5 m2" }] } },
  };
  return { header, buffer: buf.bytes() };
}

describe("parseDrawing", () => {
  it("reads sheets before views, with their geometry as Float32Array views", async () => {
    const { header, buffer } = sample();
    const doc = await parseDrawing(await gzip(buildPayload(header, buffer)));

    expect(doc.source).toEqual({ file: "model.rvt", generator: "test" });
    expect(doc.pages.map((p) => pageLabel(p))).toEqual(["A102 Plans", "{3D} (view)"]);

    const sheet = doc.pages[0].scene;
    expect(sheet.sheet).toEqual({ id: 382617, number: "A102", name: "Plans" });
    expect(sheet.max).toEqual([2.76, 1.95]);
    expect(sheet.items.map((i) => i.t)).toEqual(["path", "fill", "text", "image"]); // the unknown "hatch" is skipped
    const [path, fill, text, image] = sheet.items;
    expect(path).toMatchObject({ t: "path", closed: true, w: 0.0006, dash: [0.01, 0.02], el: 12, view: 5 });
    if (path.t !== "path" || fill.t !== "fill" || image.t !== "image") throw new Error("unexpected item types");
    expect(path.xy).toBeInstanceOf(Float32Array);
    expect(Array.from(path.xy)).toEqual([0, 0, 1.5, 0.5, 2, 1]);
    expect(fill.rings.map((r) => Array.from(r))).toEqual([[0, 0, 1, 0, 1, 1, 0, 1]]);
    expect(text).toMatchObject({ t: "text", text: "Kitchen", anchor: "cm", el: 13 });
    expect(Array.from(image.png)).toEqual(Array.from(PNG_BYTES));

    const view = doc.pages[1].scene;
    expect(view.viewInfo).toEqual({ id: 960621, name: "{3D}", scale: "1 : 100" });
    const seg = view.items[0];
    expect(seg.t === "segs" && Array.from(seg.xy)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("shares one element table between the pages", async () => {
    const { header, buffer } = sample();
    const doc = await parseDrawing(await gzip(buildPayload(header, buffer)));
    expect(doc.elements["12"]).toMatchObject({ class: "Wall", name: "Basic Wall" });
    expect(doc.pages[0].scene.elements).toBe(doc.elements);
    expect(doc.pages[1].scene.elements).toBe(doc.elements);
  });

  it("reads a payload that does not start at an aligned byte of its backing memory", () => {
    const { header, buffer } = sample();
    const payload = buildPayload(header, buffer);
    const backing = new Uint8Array(payload.length + 3);
    backing.set(payload, 1);
    const doc = parsePayload(backing.subarray(1, 1 + payload.length));
    const path = doc.pages[0].scene.items[0];
    expect(path.t === "path" && Array.from(path.xy)).toEqual([0, 0, 1.5, 0.5, 2, 1]);
  });

  it("uses the injected decompress step", async () => {
    const { header, buffer } = sample();
    const doc = await parseDrawing(new Uint8Array([9, 9, 9]), async () => buildPayload(header, buffer));
    expect(doc.pages).toHaveLength(2);
  });

  it("accepts a page with no items and a header without elements", async () => {
    const header = { format: "drawing", version: 1, pages: [{ id: 1, kind: "view", name: "v", min: [0, 0], max: [1, 1], items: [] }] };
    const doc = await parseDrawing(await gzip(buildPayload(header, new Uint8Array(0))));
    expect(doc.pages[0].scene.items).toEqual([]);
    expect(doc.elements).toEqual({});
  });
});

describe("parseDrawing errors", () => {
  const open = async (payload: Uint8Array) => parseDrawing(await gzip(payload));

  it("rejects bytes that are not a gzip stream", async () => {
    await expect(parseDrawing(new TextEncoder().encode("{}"))).rejects.toThrow(/gzip/);
  });

  it("rejects a bad magic", async () => {
    const { header, buffer } = sample();
    await expect(open(buildPayload(header, buffer, { magic: "NOTDRAW\0" }))).rejects.toThrow(/bad magic/);
  });

  it("rejects another version, naming both versions", async () => {
    const { header, buffer } = sample();
    await expect(open(buildPayload(header, buffer, { version: 2 }))).rejects.toThrow(/version 2.*version 1/);
  });

  it("rejects a header that runs past the end", () => {
    const payload = buildPayload({ format: "drawing" }, new Uint8Array(0));
    new DataView(payload.buffer).setUint32(12, 100000, true);
    expect(() => parsePayload(payload)).toThrow(/header length 100000/);
  });

  it("rejects a header that is not drawing JSON", () => {
    expect(() => parsePayload(buildPayload({ format: "scene", pages: [] }, new Uint8Array(0)))).toThrow(/header\.format/);
    expect(() => parsePayload(buildPayload({ format: "drawing" }, new Uint8Array(0)))).toThrow(/header\.pages/);
  });

  it("rejects a blob that lies outside the buffer, naming the item", () => {
    const { header, buffer } = sample();
    (header.pages[0].items[0] as { segs: number[] }).segs = [0, buffer.length + 16];
    expect(() => parsePayload(buildPayload(header, buffer))).toThrow(/pages\[0\]\.items\[0\]\.segs.*out of bounds/);
  });

  it("rejects a blob that starts off a 4-byte boundary", () => {
    const { header, buffer } = sample();
    (header.pages[0].items[0] as { segs: number[] }).segs = [2, 16];
    expect(() => parsePayload(buildPayload(header, buffer))).toThrow(/offset 2 is not a multiple of 4/);
  });

  it("rejects coordinate blobs that are not whole points or segments", () => {
    const { header, buffer } = sample();
    (header.pages[0].items[0] as { segs: number[] }).segs = [0, 12]; // three floats
    expect(() => parsePayload(buildPayload(header, buffer))).toThrow(/length 12 is not a multiple of 16/);
  });

  it("rejects a coordinate that is not finite", () => {
    const buf = new BlobBuffer();
    const pts = buf.add(f32(0, 0, NaN, 1));
    const header = { format: "drawing", version: 1, pages: [{ id: 1, kind: "view", name: "v", min: [0, 0], max: [1, 1], items: [{ t: "path", pts, w: 1 }] }] };
    expect(() => parsePayload(buildPayload(header, buf.bytes()))).toThrow(/coordinate 2 is not a finite number/);
  });

  it("keeps an image blob that is not a PNG, leaving the browser to skip it", () => {
    const buf = new BlobBuffer();
    const png = buf.add(new Uint8Array([1, 2, 3]));
    const header = { format: "drawing", version: 1, pages: [{ id: 1, kind: "view", name: "v", min: [0, 0], max: [1, 1], items: [{ t: "image", min: [0, 0], max: [1, 1], png }] }] };
    const image = parsePayload(buildPayload(header, buf.bytes())).pages[0].scene.items[0];
    expect(image.t === "image" && Array.from(image.png)).toEqual([1, 2, 3]);
  });

  it("rejects a page of an unknown kind or without area", () => {
    const page = { id: 1, kind: "plan", name: "v", min: [0, 0], max: [1, 1], items: [] };
    expect(() => parsePayload(buildPayload({ format: "drawing", version: 1, pages: [page] }, new Uint8Array(0)))).toThrow(/pages\[0\]\.kind/);
    expect(() => parsePayload(buildPayload({ format: "drawing", version: 1, pages: [{ ...page, kind: "view", max: [0, 0] }] }, new Uint8Array(0)))).toThrow(/pages\[0\]\.max/);
  });
});
