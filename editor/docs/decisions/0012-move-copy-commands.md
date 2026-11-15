# 0012 — `move` and `copy` commands for host elements

Date: 2026-11-15 · Status: accepted

## Context

S2 (`docs/tasks/S2-move-copy.md`) lets the user drag elements and copy/paste them. Elements drawn this session need no
new contract: their decision and command are replaced (a move) or added (a paste). Elements already on a `.drawing` /
Revit sheet cannot be moved or copied with the existing ops (`core/types` `Command`, frozen, rule 5).

## Alternatives considered

- **Delete and create again**: loses the element's id, hosted doors and windows, tags and parameters, and cannot recreate
  system families from a sheet.
- **Geometry edits kept in the session only**: never reach Revit or the command file, which is the point.

## Decision

Two ops in `Command`:

```ts
{ op: 'move'; id; sheetId; targets: string[]; at: Point; dx: number; dy: number; strokeId: string } // strokeId "move:<elementId>"
{ op: 'copy'; id; sheetId; targets: string[]; at: Point; toSheetId: string; to: Point; strokeId: string } // strokeId "copy:<n>"
```

- `at` is the grab point in sheet points on `sheetId`: the plugin maps the offset through the plan viewport under it.
- `move`: one command per element; a second drag of it replaces the first with the summed offset. Joined walls follow.
- `copy`: the targets are copied so that `at` lands on `to` on `toSheetId` (the same sheet or another level's plan). A
  wall's hosted doors and windows are copied with it; on another level the copies take that level.
- Not in `COMMAND_OPS` / `OP_FOR_KIND`: no decision kind emits them. No stroke makes them (synthetic `strokeId`).

Consumers updated in the same change: the command file (`app/source/command-file.ts`), the session restore
(`app/session.ts`), the Revit panel anchors (`anchorOf`), the Revit link (`Brush.Link.Core` `MoveElements`,
`CopyElements`).
