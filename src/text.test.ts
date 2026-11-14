import { describe, expect, it } from "vitest";
import { boxCorners, layoutText, pointInTextBox, wrapLines, type TextSpec } from "./text";

// Every character is half an em wide.
const measure = (text: string, fontSize: number) => text.length * fontSize * 0.5;

// size 0.716 is a capital height of exactly 1 em of 1.0 paper feet, so widths are easy to read.
const spec = (over: Partial<TextSpec>): TextSpec => ({
  text: "AB",
  at: [10, 10],
  size: 0.716,
  anchor: "lb",
  dir: [1, 0],
  maxWidth: null,
  bold: false,
  ...over,
});

describe("wrapLines", () => {
  it("breaks at newlines", () => {
    expect(wrapLines("one\ntwo", null, 1, false, measure)).toEqual(["one", "two"]);
  });
  it("wraps at word breaks when the line would exceed maxWidth", () => {
    expect(wrapLines("Kitchen sink area", 5, 1, false, measure)).toEqual(["Kitchen", "sink area"]);
  });
  it("keeps a word longer than maxWidth on its own line", () => {
    expect(wrapLines("Extraordinary day", 3, 1, false, measure)).toEqual(["Extraordinary", "day"]);
  });
});

describe("layoutText", () => {
  it("measures the box from the widest line and the line count", () => {
    const l = layoutText(spec({ text: "AB\nABCD" }), measure);
    expect(l.lines).toEqual(["AB", "ABCD"]);
    expect(l.width).toBeCloseTo(2, 9);
    expect(l.height).toBeCloseTo(2.4, 9);
  });

  it("centres the box on the anchor for cm", () => {
    const l = layoutText(spec({ anchor: "cm" }), measure);
    expect(l.origin[0]).toBeCloseTo(9.5, 9); // 10 - width/2
    expect(l.origin[1]).toBeCloseTo(10.6, 9); // 10 + height/2
  });

  it("puts the box left of and above the anchor for rb", () => {
    const l = layoutText(spec({ anchor: "rb" }), measure);
    expect(l.origin[0]).toBeCloseTo(9, 9);
    expect(l.origin[1]).toBeCloseTo(11.2, 9);
  });

  it("puts the box right of and below the anchor for lt", () => {
    const l = layoutText(spec({ anchor: "lt" }), measure);
    expect(l.origin[0]).toBeCloseTo(10, 9);
    expect(l.origin[1]).toBeCloseTo(10, 9);
  });

  it("rotates the box with the baseline direction", () => {
    // text reading upwards: its "up" is -x, so the box hangs to the +x side of a bottom-left anchor
    const l = layoutText(spec({ dir: [0, 1], anchor: "lb" }), measure);
    expect(l.origin[0]).toBeCloseTo(8.8, 9);
    expect(l.origin[1]).toBeCloseTo(10, 9);
    const c = boxCorners(l);
    expect(c.map((n) => Math.round(n * 1e6) / 1e6)).toEqual([8.8, 10, 8.8, 11, 10, 11, 10, 10]);
  });
});

describe("pointInTextBox", () => {
  const l = layoutText(spec({ anchor: "cm" }), measure); // x 9.5..10.5, y 9.4..10.6
  it("is inside the box", () => {
    expect(pointInTextBox(l, 10, 10)).toBe(true);
  });
  it("is outside the box", () => {
    expect(pointInTextBox(l, 10.6, 10)).toBe(false);
  });
  it("grows by the padding", () => {
    expect(pointInTextBox(l, 10.6, 10, 0.2)).toBe(true);
  });
});
