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
