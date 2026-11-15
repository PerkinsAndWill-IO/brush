import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageLabel, parseDrawing } from "./drawing-file";

describe("public/scenes/house-legacy.drawing (the old house sample, legacy gzip format)", () => {
  it("opens as three pages whose items point at described elements", async () => {
    const doc = await parseDrawing(readFileSync(new URL("../public/scenes/house-legacy.drawing", import.meta.url)));

    expect(doc.pages.map((p) => pageLabel(p))).toEqual(["A102 Plans", "A103 Elevations/Sections", "{3D} (view)"]);
    expect(doc.pages[2].scene.viewInfo).toMatchObject({ id: 960621, name: "{3D}" });
    expect(Object.keys(doc.elements).length).toBeGreaterThan(100);

    for (const page of doc.pages) {
      expect(page.scene.items.length).toBeGreaterThan(100);
      const described = page.scene.items.filter((i) => i.el !== null && doc.elements[String(i.el)]?.class);
      expect(described.length).toBeGreaterThan(10);
    }
  });
});
