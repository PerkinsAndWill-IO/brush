import { describe, expect, it } from "vitest";
import { parseScene, sceneTitle } from "./scene";

const base = { format: 1, sheet: { id: 1, number: "A102", name: "Plans" }, min: [0, 0], max: [2.76, 1.95], items: [], elements: {} };

describe("parseScene", () => {
  it("reads a sheet and its title", () => {
    const s = parseScene(base);
    expect(s.max).toEqual([2.76, 1.95]);
    expect(sceneTitle(s)).toBe("A102 Plans");
  });

  it("accepts a single view with viewInfo and no sheet", () => {
    const s = parseScene({ ...base, sheet: null, viewInfo: { id: 5, name: "Level 1", scale: 96 } });
    expect(s.sheet).toBeNull();
    expect(sceneTitle(s)).toBe("Level 1");
  });

  it("flattens points and defaults missing optional fields", () => {
    const s = parseScene({
      ...base,
      items: [
        { t: "path", pts: [[0, 0], [1, 2]], closed: true, w: 0.001, c: [1, 2, 3], dash: [] },
        { t: "segs", segs: [0, 0, 1, 1, 2, 2, 3, 3], w: 0.001 },
        { t: "fill", rings: [[[0, 0], [1, 0], [1, 1]]], c: [9, 9, 9], el: 4, view: null },
        { t: "text", text: "Hi", at: [0, 0], size: 0.01, c: [0, 0, 0] },
      ],
    });
    const [path, segs, fill, text] = s.items;
    expect(path).toMatchObject({ t: "path", closed: true, el: null, view: null });
    expect(path.t === "path" && Array.from(path.xy)).toEqual([0, 0, 1, 2]);
    expect(segs).toMatchObject({ t: "segs", c: [0, 0, 0], dash: [] });
    expect(segs.t === "segs" && segs.xy.length).toBe(8);
    expect(fill).toMatchObject({ t: "fill", el: 4 });
    expect(text).toMatchObject({ t: "text", anchor: "lb", dir: [1, 0], maxWidth: null, bold: false });
  });

  it("normalises the text direction", () => {
    const s = parseScene({ ...base, items: [{ t: "text", text: "x", at: [0, 0], size: 1, dir: [0, 3] }] });
    expect(s.items[0]).toMatchObject({ dir: [0, 1] });
  });

  it("skips item types it does not know", () => {
    const s = parseScene({ ...base, items: [{ t: "hatch" }, { t: "segs", segs: [0, 0, 1, 1], w: 1 }] });
    expect(s.items.map((i) => i.t)).toEqual(["segs"]);
  });

  it("rejects another format version", () => {
    expect(() => parseScene({ ...base, format: 2 })).toThrow(/format/);
  });

  it("rejects a segs array that is not whole segments", () => {
    expect(() => parseScene({ ...base, items: [{ t: "segs", segs: [0, 0, 1], w: 1 }] })).toThrow(/multiple of 4/);
  });

  it("rejects a page with no area", () => {
    expect(() => parseScene({ ...base, max: [0, 0] })).toThrow(/max/);
  });

  it("rejects non-numeric coordinates with the item index in the message", () => {
    expect(() => parseScene({ ...base, items: [{ t: "path", pts: [[0, "a"]], w: 1 }] })).toThrow(/items\[0\]/);
  });
});
