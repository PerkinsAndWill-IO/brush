# 0011 A `set_type` command for host elements

Date: 2026-11-15

## Context

S1 (docs/tasks/S1-select-and-retype.md) lets the user select elements on the board and change their type from a
right-click menu. For elements drawn in this session that needs no new contract: the accepted decision and its
command are replaced (another `wallType`, `familyType` or `family`, or another op when the stroke is read as another
kind). For the elements already on a `.drawing` / Revit sheet there was no way to say "this wall is now another type":
the command vocabulary (`core/types` `Command`) only creates and deletes.

## Decision

Add one op to `Command` (rule 5, `core/types` is frozen):

```ts
{ op: 'set_type', id, sheetId, targets: string[], typeName: string, family?: string, strokeId: string }
```

- `targets` are host element ids (the `.drawing` element keys, which are the Revit element ids), like `delete`.
- `typeName` is the type as the drawing names it (`DrawingElement.type`); `family` its family when the host has one.
- One command per element. No stroke makes it, so `strokeId` is `type:<element id>`: unique, never a real stroke id,
  and stable, so a second change to the same element replaces the first.
- It is not in `COMMAND_OPS` / `OP_FOR_KIND`: no decision kind emits it.

Consumers updated in the same change: the command file accepts the op (`app/source/command-file.ts`), the session
sidecar keeps `set_type` commands although they have no stroke (`app/session.ts`), the Revit panel pins its result at
the element (`anchorOf`), and the board marks each pending change on the sheet (`app/select/SelectLayers.tsx`).

The Revit plugin (`revit/`) applies the op since S1-06 (`ChangeTypeId` on the element, the type found among its valid
types by family and name or the sheet's "Family: Type" key; revert puts the old type back). An older plugin reports it
as failed without breaking the batch, as the protocol says for unknown ops.

## Alternatives considered

- **Keep sheet-element type changes outside the command log** (a list in the session): no contract change, but the
  change would never reach Revit or the command file, which is the point of changing a type.
- **Delete the element and create a new one of the other type**: loses the element's id, hosted elements (doors in a
  wall), tags and parameters. A type change in Revit keeps all of these.
