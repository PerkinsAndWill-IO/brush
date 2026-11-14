import { describe, expect, it } from "vitest";
import { pageLabel } from "./drawing-file";
import { openDocument } from "./open";
import { buildPayload, gzip } from "./testing/drawing-builder";

const scene = { format: 1, sheet: { id: 1, number: "A102", name: "Plans" }, min: [0, 0], max: [2, 1], items: [{ t: "segs", segs: [0, 0, 1, 1], w: 0.001 }], elements: { "7": { class: "Wall" } } };
const bytes = (s: string) => new TextEncoder().encode(s);

describe("openDocument", () => {
  it("opens a scene JSON as a one-page document", async () => {
    const doc = await openDocument(bytes(JSON.stringify(scene)));
    expect(doc.pages.map((p) => pageLabel(p))).toEqual(["A102 Plans"]);
    expect(doc.elements).toEqual({ "7": { class: "Wall" } });
  });

  it("opens a scene JSON of a single view as a view page", async () => {
    const doc = await openDocument(bytes(JSON.stringify({ ...scene, sheet: null, viewInfo: { id: 9, name: "Level 1", scale: 96 } })));
    expect(doc.pages.map((p) => pageLabel(p))).toEqual(["Level 1 (view)"]);
  });

  it("opens a gzip stream as a .drawing", async () => {
    const header = { format: "drawing", version: 1, pages: [{ id: 3, kind: "sheet", number: "A1", name: "Title", min: [0, 0], max: [1, 1], items: [] }] };
    const doc = await openDocument(await gzip(buildPayload(header, new Uint8Array(0))));
    expect(doc.pages.map((p) => pageLabel(p))).toEqual(["A1 Title"]);
  });

  it("says what it could not read", async () => {
    await expect(openDocument(bytes("MZ binary garbage"))).rejects.toThrow(/Not a \.drawing.*not scene JSON/);
    await expect(openDocument(bytes(JSON.stringify({ ...scene, format: 2 })))).rejects.toThrow(/format/);
  });
});
