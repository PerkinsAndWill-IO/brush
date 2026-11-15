# Move and copy/paste elements on the board

Status: approved · 2026-11-15 · branch `zcz-move-copy` (on top of PR #67)

## Intent

Sketching is iterative: you draw a wall, then see it should sit a bit to the right; you place a desk and want three more
like it. Today the only fix is erase and redraw. The user wants to **grab an element with the Select tool and drag it**,
and to **copy it with Ctrl+C and paste it under the cursor with Ctrl+V**, both for elements drawn in this session and for
elements that are already in the Revit model, with the result happening in Revit too.

## Goals

**Move (drag)**
- With the Select tool, press on an element's body (a wall along its line, a door at its opening, furniture inside its
  box; the same picking as S1's click-to-select, `drawnAt` / `elementAt`) and drag it. A plain click still selects (S1);
  a press that moves past a small threshold is a move.
- If the pressed element is part of the selection, the whole selection moves together; otherwise it is selected first
  and moves alone.
- The element follows the pointer with its selection highlight. While dragging it snaps like drawing does (a wall's ends
  to nearby walls and corners; a door to the wall under it), keeping its direction. Shift held while dragging: no snap.
- Letting go makes the move. One undo step; Ctrl+Z puts it back (in Revit too).
- **Drawn elements** (user confirmed): the stroke's ink moves with it; its decision and command are replaced by the moved
  ones (S1's `StrokeHistory.replace`), so Revit gets the old element reverted and the new one applied.
- **A drawn element still being read** (the chips "Wall 43% / Markup" showing): grabbing it with the Select tool first
  accepts it as the leading chip, then moves it (user confirmed).
- **Existing (host) elements** (user confirmed: they move in Revit): a new `move` command; Revit moves the element itself
  (`ElementTransformUtils.MoveElement`), so it keeps its id, hosted doors/windows, tags and parameters. A wall takes its
  doors along; a door dragged along its wall slides along it (Revit keeps it hosted).
- Until Revit sends the updated sheet, the element's own lines are drawn at the new position with a "moved" marker; the
  old position is dimmed.

**Copy / paste**
- Click an element (or Shift-click several), Ctrl+C; move the pointer elsewhere, Ctrl+V: the copy lands **under the
  cursor** (user's words). Several elements keep their arrangement; the group's centre goes to the cursor. Then it snaps
  like a move.
- Ctrl+V again pastes another copy at the new cursor position. Each paste is one undo step.
- **Drawn elements**: a paste is a new drawn element of the same kind and type (a new stroke whose ink is the copied
  ink, offset), committed like a drawing, so Revit gets a new element.
- **Existing elements**: a new `copy` command; Revit copies the element (`ElementTransformUtils.CopyElement`), same type
  and parameters. Its lines show at the paste spot with a "copied" marker until Revit's updated sheet arrives.
- Paste lands on whichever sheet is under the cursor, including another sheet than the one copied from (*author's
  call*: the user said "all good" without answering; for existing elements the add-in moves the copy between levels
  through the two plan viewports).

**Both**
- Sending follows the "Stream edits to Revit" switch (M6-12): sent at once when streaming, waiting for "Send now" when
  paused.
- Moves and pastes are saved with the session and exported in the command file.

## Non-goals

- Rotating, mirroring, aligning, arrays; dragging a single wall end (stretch).
- Cut (Ctrl+X): copy then erase does it.
- Moving or copying on plain PDFs (their lines are not elements) and on view pages (3D, sections, elevations): only
  sheets with plan viewports map a sheet position to a model position.
- Copy/paste between different files or browser tabs.

## Anti-goals

- A click meant to select that moves the element by a few points (the drag threshold must hold).
- A drag on empty paper that moves anything (it pans, as today).
- A move or copy that loses an existing element's identity in Revit (delete + recreate).
- A pasted door floating off any wall.

## What exists (facts from the code)

- S1 selection (`editor/src/app/select/selection.ts`, `Board.tsx`): `clickSelect` on a Select-tool click; `itemUnder` =
  `drawnAt` (drawn elements) then `elementAt` (host elements); `selection.select/toggle`, `resolveSelection` →
  `Resolved` (`drawn`: strokeId, decision, kind; `sheet`: element id, sheet id, category). A Select-tool press is the
  `inspect` gesture; a drag pans.
- Changing drawn elements in one undo step: `session.replaceElements(changes)` / `StrokeHistory.replace` (S1-05);
  `commandFromDecision` builds a decision's command; `nextCommandId(…, commandSeq)` (PR #67) gives fresh ids.
- Commands are a frozen contract (`src/core/types`, rule 5): `create_wall`, `place_door`, `place_instance`, `delete`,
  `set_type` (decision 0011). New ops need a decision record and every consumer updated (command file, sync, HUD, session
  restore, `anchorOf`, the add-in's `CommandJsonConverter`).
- Revit add-in: `SheetGeometry.PlanViewportAt(sheetFt)` and `ViewportInfo.ToModel` map sheet points to model points with
  the level's elevation (`revit/src/Brush.Link.Core/Geometry/Geometry.cs`); `CommandPlanner` turns commands into model
  ops; `CommandApplier` runs them in transactions and records what each created in the ledger for revert.
- Snapping: `snapPoint` / `snapAngle` (`core/geometry`) and the brush's door shaping (`shapeDoor`) already put a door on
  the nearest wall.

## Decided after review

User's answers:
- **Joined walls follow** a moved host wall, as in Revit (joined walls stretch so corners stay connected). The ghost
  draws them stretched too; undo restores them exactly (the add-in records their geometry before the move).
- **A host element pasted on another level's plan belongs to that level**: base/top constraints set to the target
  plan's level, original offsets kept (as if placed fresh there).
- **Copying a host wall copies the doors and windows it hosts** with it.

Author's calls (from the review, a sensible default each):
- **A host door slides along its own wall only**: dragging projects it onto that wall's line; it cannot be dragged onto
  another wall (re-hosting is out of scope).
- **A pasted host door or window** snaps to the nearest wall within 1 m of the cursor (real size); with none, the paste
  is refused with a message. It must be a wall Revit has (a host wall, or a drawn wall already applied); otherwise the
  paste says why.
- **Doors drawn on a drawn wall move with it**, in the same undo step (their `hostWallRef` follows the wall's new
  command).
- **One `move` per host element** (`strokeId: move:<element id>`, like `set_type`): a second drag of the same element
  replaces its move with the summed offset (Revit reverts and re-applies). A group drag makes one move per element,
  all in one undo step.
- **Commands carry the grab point** (`at`, sheet points on the source sheet) so the add-in picks the plan viewport
  under it (a sheet can show one element in two plan viewports at different scales).
- **A host copy Revit has not confirmed yet cannot be grabbed or copied** again: its ghost is not selectable and its
  hint says it waits for Revit.
- **Drawn elements pasted on a sheet of another scale keep their real-world size** (their geometry is rescaled).

## How (decided)

1. **Two new ops** (decision record 0012), host elements only:
   - `move` `{ op, id, sheetId, targets: [elementId], at: Point, dx, dy, strokeId: "move:<elementId>" }`: offset in
     sheet points on `sheetId`, measured at `at`.
   - `copy` `{ op, id, sheetId, targets: string[], at: Point, toSheetId, to: Point, strokeId: "copy:<n>" }`: the
     elements under `at` on `sheetId` are copied so that `at` lands on `to` on `toSheetId` (the same or another sheet).
   Drawn elements need no new op: their decision and command are replaced (move) or a new stroke + decision + command
   is added (paste).
2. **Add-in**: both ops go through the plan viewport under `at` (and under `to` on `toSheetId` for a copy) to a model
   vector. `move`: `ElementTransformUtils.MoveElement(s)` with joined walls following (the default); the ledger keeps
   the moved wall's and its joined walls' location curves, and revert puts them back. `copy`:
   `ElementTransformUtils.CopyElements` with the wall's hosted doors/windows included; on another level the copies'
   base/top constraints are set to the target level, offsets kept; revert deletes the copies.
3. **Editor**: the Select tool's press becomes "move" when it starts on a selected (or then selected) element and passes
   a drag threshold; Ctrl+C/Ctrl+V keyboard handling while the board has focus; a ghost layer draws moved/copied
   elements (drawn: their geometry; host: their vector lines translated) during drag and while waiting for Revit.
4. **Tested inside Revit 2026** like the type switcher: a live script creates a test wall and a door, moves, copies
   (same sheet and another level's sheet), reverts, and deletes everything it made.

## Left to the builder

- Drag threshold (a few screen pixels) and the ghost's look.
- How a pasted drawn element's ink is represented (copied points vs. the decision's geometry redrawn as ink).
- Snapping details for a moved group (which element's ends snap).
- Requirement IDs (a new task file `S2-move-copy.md`).
