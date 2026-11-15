# C1 — Compound edits

**Goal.** Changes that build on each other in one sitting: sketch a new wall, then a door in that wall, and the door
is hosted in the new wall. Before C1 the brush only saw the sheet's own context (the PDF or package), so a door drawn
on a wall sketched minutes earlier had no host and read as markup or a door in some other wall.

**How.**

- `core/context/session.ts` `withSessionElements(ctx, commands)`: the session's `create_wall` commands on the sheet
  become `wall` context items whose id is the command id; items and session walls named by a `delete` drop out;
  strokes already applied to a linked model (M6 `hidden`) are skipped, the redrawn sheet has the real wall. Pure,
  cached by identity. Shape-only contexts stay shape-only.
- Live brush (`app/brain/predictEngine.ts`): the context at pen-down is the sheet's plus the session's elements. A
  stroke that starts on the body of a confident wall still in its commit pause does not join it as a gesture
  (M3-11); the wall is committed first, so the door sees it. A stroke starting at a wall end still joins.
- Photo import (`app/photo/groupActions.ts`, `interpret.ts`): two passes, walls first, then the other strokes against
  the sheet plus the new walls. Walls are first in the batch; `numberCommands` turns the provisional
  `new-wall:<strokeId>` hosts into the final command ids.
- `place_door.hostWallRef` is then the wall's command id (`cmd-0007`); the Revit link already resolves such a host
  to the wall it created (`revit/docs/protocol.md`).

| ID | Requirement | Verified by |
|---|---|---|
| C1-01 | A door drawn on a wall sketched earlier in the session (after the wall committed, or during its commit pause) is hosted in that wall. | `tests/unit/context/session-elements.test.ts`, `tests/e2e/c1-compound.spec.ts` |
| C1-02 | Session walls carry their type's thickness; a closed outline gets its closing side. | unit |
| C1-03 | Deleted items and deleted session walls are not context; strokes already in the linked model are skipped. | unit |
| C1-04 | Same context and log give the same object (prepared once). | unit |
| C1-05 | Photo import: a door in a new wall from the same photo is hosted in it, whatever the stroke order; walls are applied first. | `tests/unit/app-photo-groups.test.ts` |

**Not yet.** Doors placed this session are not openings in the context (a second door at the same spot is not
refused); session furniture is not a delete target for the eraser; on a scanned / shape-only sheet a door is not
hosted in a session wall.
