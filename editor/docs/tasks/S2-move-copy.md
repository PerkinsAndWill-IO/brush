# S2 — Move and copy/paste elements

**Goal:** drag elements with the Select tool, and copy/paste them with Ctrl+C / Ctrl+V under the cursor, for elements
drawn this session and for host elements of a `.drawing` / Revit sheet; host moves and copies happen in Revit.
**Spec:** [`../superpowers/specs/2026-11-15-move-copy-design.md`](../superpowers/specs/2026-11-15-move-copy-design.md).
**Plan:** [`../superpowers/plans/2026-11-15-move-copy.md`](../superpowers/plans/2026-11-15-move-copy.md).
**Lanes:** Humans (`core/types`, decision 0012), Canvas (`src/app/**`), the Revit add-in (`../../../revit/`).

| ID | Requirement | Acceptance test |
|---|---|---|
| S2-01 | `move` and `copy` are command ops for host elements (decision 0012), exported in the command file and kept by a session reload although no stroke made them. | `tests/unit/commands/move-copy.test.ts` |
| S2-02 | One undo step can move a stroke's ink with its decision and command, or add a new stroke with them (a paste). | `tests/unit/app-history-replace-ink.test.ts` |
| S2-03 | Drawn elements move by an offset (doors on a moved drawn wall follow it) and paste under the cursor with new ids, keeping real-world size on a sheet of another scale. | `tests/unit/app-move-drawn.test.ts` |
| S2-04 | Host elements: one `move` per element (offsets add up; back to the start drops it), doors slide along their own wall, a pasted door needs a wall Revit has within 1 m, drags snap wall ends to walls and corners (not with Shift). | `tests/unit/app-move-host.test.ts` |
| S2-05 | The link plans `move` / `copy` through the plan viewport under the grab point (and the target sheet's for a copy), and reverts them. | `revit/tests/Brush.Link.Core.Tests/MoveCopyTests.cs` |
| S2-06 | Revit moves elements with joined walls following and restores them on revert; copies take a wall's doors/windows and the target level. | live (S2-08) |
| S2-07 | The board: a press past 4 px on an element drags it (a click still selects), Ctrl+C / Ctrl+V outside text fields copy and paste under the cursor, ghosts and notices. | `tests/unit/app-select-drag.test.ts`; headless Edge run |
| S2-08 | Verified inside Revit 2026 on elements the run creates. | `revit/tests/live/move-copy.live.mjs` |

## Status

In progress.
