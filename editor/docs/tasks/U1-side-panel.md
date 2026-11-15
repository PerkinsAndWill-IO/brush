# U1 — One hidden side panel, sketchy chrome

**Goal:** give the board the whole window. The tool settings (left sidebar) and the reading, session and filter
panels (right sidebar) become one panel that is hidden until asked for, and the chrome left on screen matches
the hand-drawn tool icons.
**Exit:** both requirements below pass in `tests/e2e/u1-side-panel.spec.ts` and `tests/e2e/v1-view-aids.spec.ts`.
**Lane:** Canvas (app). No change to `core/types`.

| ID | Requirement | Acceptance test |
|---|---|---|
| U1-01 | Every sidebar section (Stroke / Eraser / Measure / element data, Mode, Snapping, Commit, View, Reading your stroke, This session, Filters, Recordings) is in one side panel over the left of the board. It is closed when the app starts and opens and closes with a ☰ at the top left of the top bar, drawn as a marker sketch like the tool icons. Only the ☰ opens and closes it (Escape keeps its meaning inside, e.g. unpinning an inspected element). The board keeps its size when the panel opens or closes; the scale bar moves out from under it. | E2E: closed on load; ☰ opens it with both groups in it and `aria-expanded`; the board's width is unchanged; the ☰ closes it (`u1-01-side-panel.png`) |
| U1-02 | The scale bar is drawn as a marker sketch (wobbly outline, scribble-filled quarters) and still measures true: the bar is exactly its length between its end ticks. | V1-01's width check against the zoom, unchanged |

**Tests elsewhere:** tests that use a sidebar control open the panel first with `openSidePanel(page)` from
`tests/e2e/helpers.ts`.
