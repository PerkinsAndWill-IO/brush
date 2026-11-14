# V3 — Inspect elements on `.drawing` sheets

**Goal:** bring the schema viewer's element inspection to the editor. A `.drawing` (and every live Revit sheet) knows
which host element each line, fill and text belongs to, and element ids are shared by all its pages: show that data,
and show where else the element is drawn.
**Exit:** all requirements below pass in `tests/unit/app-drawing-inspect.test.ts` and `tests/e2e/v3-inspect.spec.ts`.
**Lane:** Canvas (app). No change to `core/types` or `core/drawing`.

| ID | Requirement | Acceptance test |
|---|---|---|
| V3-01 | With the Select tool (V), hovering an item that belongs to an element highlights all of that element's items on **every sheet** it appears on (a tag also highlights the element it labels). Strokes and text win over fills; items without an element and items hidden by the display filters are passed over. | Unit tests of `hitItem` / `elementAt`; E2E hovers the fireplace on A102 and finds the highlight on all 3 pages (`v3-inspect-all-sheets.png`) |
| V3-02 | While the Select tool is on, its panel in the left sidebar shows the hovered element's data (category, name, family / type, level, element id, parameters with readable labels; a tag shows "Room tag → Kitchen"). A click pins it; while pinned, hover does not change it. Esc, the unpin button or a click on empty paper releases it. A drag with the Select tool pans and does not pin. | Unit tests of `resolveElement`, labels and the store; E2E (`v3-inspect.png`) |
| V3-03 | The panel lists the sheets the element appears on; clicking one fits that sheet. | Unit test of `itemsOf`; E2E clicks the A103 chip |

Hit-testing follows the schema viewer (`schema/src/hit.ts`): primitives in a uniform grid per page, built once on first
hover and cached per page, so a pick is well under a millisecond on large sheets. Sources expose their vectors through
the optional `DrawingSource.vectorPage(sheetId)`; PDFs have none, and the Select tool says so.

**Budgets:** none new.
