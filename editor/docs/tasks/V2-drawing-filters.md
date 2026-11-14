# V2 — Display filters for `.drawing` pages

**Goal:** cut the noise on busy host sheets. A `.drawing` carries each item's element, and so its category
(Walls, Dimensions, Grids, Furniture, ...): let the user hide whole categories or whole item kinds.
**Exit:** all requirements below pass in `tests/unit/app-drawing-filters.test.ts` and `tests/e2e/v2-drawing-filters.spec.ts`.
**Lane:** Canvas (app). No change to `core/types` or `core/drawing`.

| ID | Requirement | Acceptance test |
|---|---|---|
| V2-01 | With a binary `.drawing` open, a Filters section in the right sidebar lists the file's categories (element category, else its class label, else "No category") with item counts, most items first. Unticking one re-renders the pages without its items. Show all brings everything back. Not shown for PDFs or manifest packages. | Unit test of `categoriesOf` / `hiddenPredicate`; E2E unticks Walls and checks fewer inked pixels (`v2-drawing-filters.png`) |
| V2-02 | Show Lines / Fills / Text / Images toggles hide every item of that kind, across categories. | Unit test; E2E hides fills on top of Walls and checks fewer inked pixels again |
| V2-03 | Hide annotation hides every listed category that reads as annotation (dimensions, tags, text notes, grids, levels, title blocks, viewports, schedules, legends, ...) in one click; it toggles back to Show annotation. | Unit test of `isAnnotationCategory`; E2E checks Grids and Title Blocks off, Doors on |

Filters are display only: hidden items still feed the sheet context (snapping, predictions), and nothing is written
to the sidecar or the command log. Choices are remembered per browser by category name (`brush.filters.v1`), so they
carry across files.

**Budgets:** none new. A filter change re-renders each page once (compiled commands are cached per filter version).
