# V1 — View aids (from the chSpace viewer)

**Goal:** small aids for reading drawings at any zoom, ported from the chSpace responsive-drawing prototype
(`PerkinsAndWill-IO/chspace-app`): a graphic scale, real-unit measuring, a metric grid, adjustable label
size, and on-board marks that keep their screen size during a zoom.
**Exit:** all five requirements below pass in `tests/e2e/v1-view-aids.spec.ts` and `tests/unit/app-view-aids.test.ts`.
**Lane:** Canvas (app). No change to `core/types`; the sheet scale comes from `Sheet.scale` (package) or `SheetContext.scale` (inferred from text like "1:100").

| ID | Requirement | Acceptance test |
|---|---|---|
| V1-01 | A graphic scale bar in the bottom-left corner of the board shows a 1-2-5 length (0 · half · full) for the sheet in the middle of the viewport (else the nearest visible one), with its number and scale. Its width follows the zoom. Hidden when the scale is unknown; can be turned off in View. | Unit test of `scaleBarFor`; E2E checks bar width = metres × pt/m × zoom before and after zooming, and the toggle (`v1-01-scale-bar.png`) |
| V1-02 | A Measure tool (M) measures on one sheet by dragging, or by clicking two points, and labels the line in real units (mm / m) when the scale is known. Ends snap to walls and grid lines when snapping is on. Escape drops a half-drawn one; Backspace removes the last; the sidebar lists them with Remove and Clear all. Measurements are not saved or sent as commands, and clear when another document opens. | Unit test of `sheetDistanceMetres` / `formatMetres`; E2E drag and click-click measured against the camera zoom (`v1-02-measure.png`) |
| V1-03 | A metric grid (View → Metric grid) on sheets with a known scale: minor lines at 0.1 / 0.5 / 1 / 5 / 10 … m, majors every 5 minors, spacing chosen when the camera settles so minors are at least 10 px apart. Drawn under the ink. The setting is remembered per browser. | Unit test of `gridSpacingFor`; E2E toggles it and checks spacing gets finer when zoomed in, and that it survives a reload (`v1-03-grid.png`) |
| V1-04 | Label size S / M / L / XL (0.85 / 1 / 1.2 / 1.45) scales on-board text (sheet names, measurement labels, pen chips, scale bar) independently of the zoom. Remembered per browser. | E2E checks the sheet-name font size ratio (`v1-04-label-size.png`) |
| V1-05 | Overlay and grid layers get the live zoom (`--z`) every frame, so marks and labels sized in screen px keep their size during a zoom instead of jumping when it settles. The rest of the world (paper shadows, sheet names) still updates on settle, as before. | E2E reads `--z` mid-gesture on the overlay vs the world |

**Not ported:** chSpace's north arrow (a plain PDF gives no reliable north), its camera (brush's is more complete),
and its Konva markup layer (brush overlays are SVG in sheet points; no new dependency).

**Budgets:** none new. V1-05 adds a per-frame custom-property write on two SVG layers per sheet; `panZoomFps` (M1) still gates it.
