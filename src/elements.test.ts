import { describe, expect, it } from "vitest";
import { categoryOf, paramLabel, resolveElement } from "./elements";

const elements = {
  "857191": { class: "RoomElem", category: "Rooms", name: "206 Master Bedroom", params: [] },
  "857192": { class: "RoomTag", category: undefined, tagged: 857191, params: [] },
  "5": { class: "IndependentTag", tagged: 999, params: [] },
  "7": { class: "SWall", category: "Walls", params: [] },
};

describe("resolveElement", () => {
  it("shows the tagged element for a tag and highlights both", () => {
    const r = resolveElement(elements, 857192);
    expect(r.id).toBe(857191);
    expect(r.info?.name).toBe("206 Master Bedroom");
    expect(r.tagLabel).toBe("Room tag");
    expect(r.highlight).toEqual([857192, 857191]);
  });
  it("keeps a plain element as it is", () => {
    const r = resolveElement(elements, 7);
    expect(r).toMatchObject({ id: 7, tagLabel: null, highlight: [7] });
  });
  it("falls back to the tag itself when the tagged element is missing", () => {
    const r = resolveElement(elements, 5);
    expect(r).toMatchObject({ id: 5, tagLabel: null, highlight: [5] });
  });
});

describe("categoryOf", () => {
  it("uses the class when the category is missing", () => {
    expect(categoryOf({ class: "LinearDimString" })).toBe("Linear dim string");
    expect(categoryOf({ class: "SWall", category: "Walls" })).toBe("Walls");
    expect(categoryOf(undefined)).toBe("Element");
  });
});

describe("paramLabel", () => {
  it.each([
    ['ROOM_AREA', 'Room area'],
    ['ALL_MODEL_TYPE_MARK', 'All model type mark'],
    ['WALL_BASE_OFFSET', 'Wall base offset'],
    ['Area', 'Area'],
])("%s -> %s", (raw, label) => expect(paramLabel(raw)).toBe(label));
});
