import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";

const load = (f: string) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false }).compile(load("../schema/scene.schema.json"));

describe("scene schema", () => {
  it("accepts the fixture scene", () => {
    const ok = validate(load("../public/scenes/fixture.json"));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("accepts an element that refers to another element", () => {
    const scene = { format: 1, sheet: null, viewInfo: { id: 1, name: "v", scale: 100 }, min: [0, 0], max: [1, 1], items: [], elements: { "2": { class: "RoomTag", category: null, tagged: 1, params: [] } } };
    expect(validate(scene)).toBe(true);
  });

  it("rejects a wrong format and an odd-shaped item", () => {
    expect(validate({ format: 2, min: [0, 0], max: [1, 1], items: [] })).toBe(false);
    expect(validate({ format: 1, min: [0, 0], max: [1, 1], items: [{ t: "segs", segs: "x", w: 1 }] })).toBe(false);
  });
});

describe("drawing header schema", () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(load("../schema/scene.schema.json"));
  const validateHeader = ajv.compile(load("../schema/drawing.schema.json"));
  const header = (items: unknown[], elements: unknown = {}) => ({
    format: "drawing",
    version: 1,
    source: { file: "model.rvt", generator: "x" },
    pages: [
      { id: 1, kind: "sheet", number: "A102", name: "Plans", scale: null, min: [0, 0], max: [2.76, 1.95], items },
      { id: 2, kind: "view", number: null, name: "{3D}", scale: "1 : 100", min: [0, 0], max: [1, 1], items: [] },
    ],
    elements,
  });

  it("accepts blob references for geometry and images, and shared elements", () => {
    const items = [
      { t: "path", pts: [0, 24], closed: false, w: 0.001, c: [0, 0, 0], dash: [], el: 7, view: 2 },
      { t: "segs", segs: [24, 32], w: 0.001 },
      { t: "fill", rings: [[56, 32], [88, 32]], c: [1, 2, 3], el: null, view: null },
      { t: "text", text: "Kitchen", at: [1, 1], size: 0.008, anchor: "cm", dir: [1, 0], maxWidth: null, c: [0, 0, 0], bold: false, el: 8, view: null },
      { t: "image", min: [0, 0], max: [1, 1], png: [120, 400] },
      { t: "hatch" },
    ];
    const ok = validateHeader(header(items, { "7": { class: "Wall", category: "Walls", tagged: null, params: [{ name: "Area", value: "1 m2" }] } }));
    expect(validateHeader.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects inline scene geometry, a bad blob reference and an unknown page kind", () => {
    expect(validateHeader(header([{ t: "path", pts: [[0, 0], [1, 1]], w: 1 }]))).toBe(false);
    expect(validateHeader(header([{ t: "segs", segs: [-4, 16], w: 1 }]))).toBe(false);
    expect(validateHeader(header([{ t: "image", min: [0, 0], max: [1, 1], png: "AAAA" }]))).toBe(false);
    const odd = header([]);
    odd.pages[0].kind = "plan";
    expect(validateHeader(odd)).toBe(false);
  });

  it("rejects an element with a malformed parameter list", () => {
    expect(validateHeader(header([], { "7": { params: [{ name: "Area" }] } }))).toBe(false);
  });
});
