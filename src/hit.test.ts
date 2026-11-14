import { describe, expect, it } from "vitest";
import { buildHitIndex, hitTest } from "./hit";
import { parseScene } from "./scene";

// Stand-in for the browser's font metrics: every character is half an em wide.
const measure = (text: string, fontSize: number) => text.length * fontSize * 0.5;

const black = [0, 0, 0];

const scene = parseScene({
  format: 1,
  sheet: null,
  min: [0, 0],
  max: [40, 40],
  items: [
    // 0: a 10x10 slab with a 2x2 hole in the middle
    { t: "fill", rings: [[[0, 0], [10, 0], [10, 10], [0, 10]], [[4, 4], [6, 4], [6, 6], [4, 6]]], c: [200, 200, 200], el: 100, view: 1 },
    // 1: two wall segments along the bottom and right edges
    { t: "segs", segs: [0, 0, 10, 0, 10, 0, 10, 10], w: 0.1, c: black, dash: [], el: 200, view: 1 },
    // 2: a top edge, drawn first
    { t: "path", pts: [[0, 10], [10, 10]], closed: false, w: 0.1, c: black, dash: [], el: 300, view: 1 },
    // 3: label sitting over the hole
    { t: "text", text: "Hello", at: [5, 5], size: 1, anchor: "cm", dir: [1, 0], maxWidth: null, c: black, bold: false, el: 400, view: 1 },
    // 4: drawn later along the same top edge, so it wins over item 2
    { t: "segs", segs: [0, 10, 10, 10], w: 0.1, c: black, dash: [], el: 500, view: 1 },
    // 5: closed triangle, only its closing edge is probed
    { t: "path", pts: [[20, 0], [30, 0], [25, 5]], closed: true, w: 0.1, c: black, dash: [], el: 600, view: 1 },
    // 6: long diagonal that crosses many grid cells
    { t: "segs", segs: [0, 40, 40, 0], w: 0.1, c: black, dash: [], el: 700, view: 1 },
    // 7: rotated text reading upwards
    { t: "text", text: "AB", at: [35, 5], size: 1, anchor: "lb", dir: [0, 1], maxWidth: null, c: black, bold: false, el: 800, view: 1 },
    // 8: a stroke without an element
    { t: "segs", segs: [15, 20, 18, 20], w: 0.1, c: black, dash: [], el: null, view: null },
  ],
  elements: {},
});
const index = buildHitIndex(scene, measure);
const hit = (x: number, y: number, tol = 0.05) => hitTest(index, x, y, tol);
const elAt = (x: number, y: number, tol = 0.05) => {
  const i = hit(x, y, tol);
  return i < 0 ? null : scene.items[i].el;
};

describe("hitTest", () => {
  it("hits the fill under the cursor", () => {
    expect(hit(2, 2)).toBe(0);
    expect(elAt(2, 2)).toBe(100);
  });

  it("does not hit a fill through its hole", () => {
    // inside the hole, below the label's box
    expect(hit(4.2, 4.1)).toBe(-1);
  });

  it("hits a point outside every shape as nothing", () => {
    expect(hit(15, 30)).toBe(-1);
  });

  it("prefers text over the fill beneath it", () => {
    expect(hit(5, 5)).toBe(3);
  });

  it("prefers a stroke within tolerance over the fill beneath it", () => {
    expect(hit(10.03, 5)).toBe(1);
    expect(hit(5, 0.03)).toBe(1);
  });

  it("falls back to the fill once the stroke is out of reach", () => {
    expect(hit(5, 0.2)).toBe(0);
  });

  it("prefers the latest drawn of two overlapping strokes", () => {
    expect(hit(5, 10)).toBe(4);
  });

  it("hits the closing edge of a closed path", () => {
    expect(hit(22.5, 2.5)).toBe(5);
    expect(hit(25, 2)).toBe(-1); // inside the triangle, away from every edge: paths are not filled
  });

  it("hits a long diagonal anywhere along it and not beside it", () => {
    expect(hit(20, 20.01)).toBe(6);
    expect(hit(33.3, 6.7)).toBe(6);
    expect(hit(20, 22)).toBe(-1);
  });

  it("widens the pick radius with the tolerance", () => {
    expect(hit(15, 20.3, 0.05)).toBe(-1);
    expect(hit(15, 20.3, 0.5)).toBe(8);
  });

  it("hits a rotated text box and not the area beside it", () => {
    // the text reads upwards from (35, 5), so its box hangs to the left of x = 35
    expect(hit(34.5, 5.5, 0.01)).toBe(7);
    expect(hit(35.5, 5.5, 0.01)).toBe(-1);
    expect(hit(34.5, 7, 0.01)).toBe(-1);
  });

  it("reports items without an element so the caller can show no card", () => {
    expect(hit(16, 20)).toBe(8);
    expect(elAt(16, 20)).toBeNull();
  });
});

describe("byElement", () => {
  it("lists every item that belongs to the same element", () => {
    const shared = buildHitIndex(
      parseScene({
        format: 1,
        sheet: null,
        min: [0, 0],
        max: [1, 1],
        items: [
          { t: "segs", segs: [0, 0, 1, 1], w: 0.01, c: black, dash: [], el: 7, view: null },
          { t: "fill", rings: [[[0, 0], [1, 0], [1, 1]]], c: black, el: 8, view: null },
          { t: "text", text: "x", at: [0.5, 0.5], size: 0.1, anchor: "cm", dir: [1, 0], maxWidth: null, c: black, bold: false, el: 7, view: null },
        ],
        elements: {},
      }),
      measure,
    );
    expect(shared.byElement.get(7)).toEqual([0, 2]);
    expect(shared.byElement.get(8)).toEqual([1]);
  });
});
