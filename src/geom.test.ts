import { describe, expect, it } from "vitest";
import { ACTUAL_SIZE_SCALE, distSqToSegment, fitView, panBy, pointInRingsEvenOdd, toScreen, toWorld, zoomAt } from "./geom";

describe("fitView", () => {
  const page = { min: [0, 0] as [number, number], max: [2.76, 1.95] as [number, number] };
  const view = fitView(page, 1000, 800, 24);

  it("scales the page to the limiting dimension", () => {
    expect(view.scale).toBeCloseTo(344.93, 2); // (1000 - 48) / 2.76
  });

  it("puts the page centre in the middle of the window", () => {
    const [x, y] = toScreen(view, 1.38, 0.975);
    expect(x).toBeCloseTo(500, 6);
    expect(y).toBeCloseTo(400, 6);
  });

  it("draws y up: the page bottom-left sits below and left of the top-right", () => {
    const [x0, y0] = toScreen(view, 0, 0);
    expect(x0).toBeCloseTo(24, 6);
    expect(y0).toBeCloseTo(736.3, 1);
    const [x1, y1] = toScreen(view, 2.76, 1.95);
    expect(x1).toBeCloseTo(976, 6);
    expect(y1).toBeCloseTo(63.7, 1);
  });
});

describe("zoomAt and panBy", () => {
  it("keeps the world point under the cursor fixed", () => {
    const v = { scale: 100, tx: 0, ty: 500 };
    expect(toWorld(v, 300, 200)).toEqual([3, 3]);
    const z = zoomAt(v, 300, 200, 2);
    expect(z).toEqual({ scale: 200, tx: -300, ty: 800 });
    expect(toWorld(z, 300, 200)).toEqual([3, 3]);
  });

  it("clamps the scale", () => {
    expect(zoomAt({ scale: 100, tx: 0, ty: 0 }, 0, 0, 1e9, 1, 5000).scale).toBe(5000);
    expect(zoomAt({ scale: 100, tx: 0, ty: 0 }, 0, 0, 1e-9, 50, 5000).scale).toBe(50);
  });

  it("pans by a screen delta", () => {
    expect(panBy({ scale: 2, tx: 10, ty: 20 }, 5, -7)).toEqual({ scale: 2, tx: 15, ty: 13 });
  });

  it("actual size is 1152 CSS px per paper foot", () => {
    expect(ACTUAL_SIZE_SCALE).toBe(1152);
  });
});

describe("distSqToSegment", () => {
  it("measures to the interior of the segment", () => {
    expect(distSqToSegment(5, 3, 0, 0, 10, 0)).toBe(9);
  });
  it("measures to the nearer end beyond the segment", () => {
    expect(distSqToSegment(13, 4, 0, 0, 10, 0)).toBe(25);
  });
  it("handles a zero-length segment", () => {
    expect(distSqToSegment(3, 4, 0, 0, 0, 0)).toBe(25);
  });
});

describe("pointInRingsEvenOdd", () => {
  const outer = [0, 0, 10, 0, 10, 10, 0, 10];
  const hole = [4, 4, 6, 4, 6, 6, 4, 6];
  it("is inside the outer ring", () => {
    expect(pointInRingsEvenOdd(2, 2, [outer, hole])).toBe(true);
  });
  it("is outside through a hole", () => {
    expect(pointInRingsEvenOdd(5, 5, [outer, hole])).toBe(false);
  });
  it("is outside beyond the outer ring", () => {
    expect(pointInRingsEvenOdd(11, 5, [outer, hole])).toBe(false);
  });
  it("does not depend on ring winding", () => {
    const reversed = [0, 10, 10, 10, 10, 0, 0, 0];
    expect(pointInRingsEvenOdd(5, 5, [reversed, hole])).toBe(false);
    expect(pointInRingsEvenOdd(2, 2, [reversed, hole])).toBe(true);
  });
});
