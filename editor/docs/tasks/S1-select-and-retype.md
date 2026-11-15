# S1 — Select elements and change their type

**Goal:** select elements on the board, both the ones drawn this session and the host elements of a `.drawing` /
Revit sheet, and change their type from a menu at the pointer.
**Exit:** all requirements below pass in `tests/unit/app-select-types.test.ts` and `tests/e2e/s1-select-retype.spec.ts`.
**Lane:** Canvas (app), plus one op in `core/types` (decision 0011).

| ID | Requirement | Acceptance test |
|---|---|---|
| S1-01 | With the Select tool (V) a click selects the element under it: a drawn element (a wall by its body, a door by its opening, furniture inside its box, markup by its ink) before a host element under it. Shift+click adds or removes one. A click on empty paper clears the selection; Esc clears it. Deletes and eraser passes are not selectable; strokes already in the linked model are not either (their element on the sheet is). | Unit tests of `drawnAt`; E2E |
| S1-02 | A right click (or the pen's barrel button), in any tool, opens the type menu for the selection (what is under the pointer is selected first if it was not). For drawn elements: **Read as** Wall / Door / Furniture / Markup (the brush reads the stroke again with that kind forced; Markup turns the element back into ink), and **Type**: the palette types of their kind. A door or furniture piece takes its new type's size about its centre when the scale is known. | Unit tests of `withType`, `paletteOptions`; E2E |
| S1-03 | For host elements the menu offers every type their category uses in the document (doors named "Family Type" as the palette names them). Several elements of one category change together; elements of different categories show a note instead of types. The element's own type is marked "original"; picking it drops the pending change. | Unit tests of `documentTypes`, `sheetElementType`; E2E |
| S1-04 | A type change of a host element goes in the command log as `set_type` (decision 0011), is saved with the session and exported in the command file, and is marked on every sheet that draws the element ("→ new type"). | Unit test of the command file; E2E |
| S1-05 | Every change from the menu is one undo step; undo puts the old elements and commands back where they were. | Unit tests of `StrokeHistory.replace`; E2E |
| S1-06 | The Revit plugin applies `set_type`: the type is found among the element's valid types by `typeId`, else by family + name, "Family: Type" or "Family Type"; one already in effect is skipped; revert sets the previous type back (also after a plugin hot reload). Edits addressed to a view (not a sheet) take `set_type` and `delete`. | `revit/tests/Brush.Link.Core.Tests/TypeSwitchTests.cs`; live: `revit/tests/live/type-switcher.live.mjs` |
| S1-07 | With Revit connected, the menu of a host element on a linked sheet lists every type Revit allows for it (`list_types`), not only the ones the document uses; an older plugin, an error or a 5 s silence keeps the document's types. | `tests/unit/revit/types.test.ts` |

**Not yet.** A multi-stroke gesture
(M3-11) read again as another kind is read from its last stroke only. The sheet is not redrawn with the new type
until the linked model sends a new version; a `.drawing` without a link only shows the marker.

**Budgets:** none new.
