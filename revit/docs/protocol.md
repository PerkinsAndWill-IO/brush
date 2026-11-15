# Brush Link protocol, version 1

The live link between the Brush Editor (a web page) and a modelling app (the Revit add-in, or the DevHost). The editor
sends the commands it already produces (editor decision 0005). The plugin applies them to the model and sends back a
new version of the sheet as a `.drawing` package, in the format the editor already opens (editor decision 0002).

Code: `src/Brush.Link.Core/Protocol/Messages.cs` (shapes), `src/Brush.Link.Core/Server/LinkHub.cs` (behaviour).
Tests: `tests/Brush.Link.Core.Tests/LinkServerTests.cs` play the editor's side.

## Transport

- **WebSocket** at `ws://127.0.0.1:47821/link` (port set by `port` in the settings file). Loopback only.
- One JSON object per **text** frame, each with a `type`. Editor-to-plugin messages are capped at 16 MB.
- `GET http://127.0.0.1:47821/health` answers `{"name":"brush-revit-link","protocol":1,"host":"Revit 2026"}`.
  The editor can use it to show whether Revit is reachable before it opens the socket.
- **Who may connect.** The `Host` header must be `localhost`, `127.0.0.1` or `[::1]` (this blocks DNS rebinding).
  The `Origin` header must be in `allowedOrigins` (the defaults are the editor's dev and preview servers,
  `http://localhost:5173` and `http://localhost:4173`). For any other origin, Revit asks the user to allow it once
  or always. A refused origin gets HTTP 403 and the WebSocket fails to open. Clients that send no Origin (scripts,
  tests) are allowed while `allowMissingOrigin` is true.
- **Chrome Local Network Access.** When the editor is served from a public origin (the Vercel deployment), Chrome asks
  the user once whether that site may reach devices on the local network. The editor should explain that prompt before
  the first connect.

## Flow

```text
editor                                   plugin
  │── hello {protocol:1} ───────────────▶│
  │◀────────────── welcome {document, sheets}
  │── open_sheet {sheetId} ─────────────▶│  subscribes this connection to the sheet
  │── show_sheet {sheetId} ─────────────▶│  Revit switches its active view to that sheet
  │◀────────────── sheet {version:1, reason:"open", package}
  │── apply {sheetId, baseVersion:1, commands} ─▶│  one Undo step in Revit
  │◀────────────── applied {results}
  │◀────────────── sheet {version:2, reason:"apply", package}
  │      … someone edits the model in Revit …
  │◀────────────── sheet {version:3, reason:"model_changed", package}
```

The plugin answers messages from one connection in order, and makes one host call at a time across all connections.
`applied` always comes before the `sheet` it caused. After an `apply` or `revert` only the edited sheet is
re-exported straight away. Other open sheets that show the same elements get their new version later, as
`model_changed`, from a background refresh (`otherSheetsAfterEditMs` after the last edit, default 3000). That refresh
exports one sheet at a time and lets a waiting `apply` or `revert` go first.

## Editor → plugin

Every message may carry a `requestId` (string). The reply, or the error, echoes it.

| type | fields | answer |
|---|---|---|
| `hello` | `protocol: 1`, `client?: string` | `welcome`. Must be the first message; anything earlier gets error `hello_required`. |
| `list_sheets` | | `sheets` |
| `open_sheet` | `sheetId` | `sheet` with `reason: "open"`. Subscribes: every later version of this sheet is pushed. |
| `close_sheet` | `sheetId` | none. Stops the pushes. |
| `show_sheet` | `sheetId` | `shown {sheetId}`. Makes the sheet the active view in Revit. The editor sends it when the user opens a sheet, or clicks one that is already open. An older plugin answers `unknown_type`, which the editor ignores. |
| `apply` | `sheetId`, `baseVersion?`, `commands: Command[]` | `applied`, then `sheet` (`reason: "apply"`) if anything changed |
| `revert` | `sheetId`, `commandIds: string[]` | `reverted`, then `sheet` (`reason: "revert"`) if anything changed |
| `ping` | | `pong` |

`commands` are the editor's `Command` objects unchanged (`editor/src/core/types/index.ts`): `create_wall`,
`place_door`, `place_instance`, `delete` and `set_type`, with coordinates in sheet points (1/72 in, origin top-left,
y down) on the sheet the package described. Unknown ops are reported as failed. They do not break the batch.

`set_type` (editor decision 0011) changes the type of elements already in the model, keeping their ids, hosted
elements, tags and parameters:

```jsonc
{ "op": "set_type", "id": "cmd-0012", "sheetId": "382617",
  "targets": ["912001"],                       // Revit element ids (or `wall-<id>`-style context ids)
  "typeName": "M_Single-Flush: 0915 x 2134mm", // as the sheet names it: a wall type's name, or "Family: Type"
  "family": "M_Single-Flush",                  // optional
  "strokeId": "type:912001" }                  // no stroke makes it: one command per element
```

## Plugin → editor

```jsonc
{ "type": "welcome", "protocol": 1,
  "server": { "name": "brush-revit-link", "version": "0.1.0", "host": "Revit 2026", "epoch": "a1b2c3d4e5f6" },
  "document": { "title": "Tower A", "path": "C:\\…\\Tower A.rvt", "project": "Tower A" },
  "sheets": [ { "id": "382617", "number": "A102", "name": "Plans" } ] }

{ "type": "sheets", "requestId": "…", "document": { … }, "sheets": [ … ] }   // also pushed, unasked, when the list changes

{ "type": "sheet", "requestId": "…", "sheetId": "382617", "version": 2, "reason": "apply",
  "package": { "schemaVersion": 1, "project": "…", "palette": { … }, "sheets": [ { "id": "382617", … } ],
               "pdf": { "name": "A102.pdf", "encoding": "base64", "data": "…" } } }

{ "type": "applied", "requestId": "…", "sheetId": "382617", "baseVersion": 1, "stale": false,
  "results": [ { "id": "cmd-0001", "status": "applied", "elementIds": ["912345", "912346"] },
               { "id": "cmd-0002", "status": "applied", "elementIds": ["912347"],
                 "notes": ["no door type 'Single-Flush 0900x2100', used the closest in size: 'M_Single-Flush: 0915 x 2134mm'"] },
               { "id": "cmd-0003", "status": "failed", "elementIds": [], "message": "cmd-0003: not inside a plan viewport on this sheet" } ] }

{ "type": "reverted", "requestId": "…", "sheetId": "382617", "results": [ … ] }
{ "type": "shown", "requestId": "…", "sheetId": "382617" }
{ "type": "pong", "requestId": "…" }
{ "type": "error", "requestId": "…", "code": "unknown_sheet", "message": "no sheet with id '1' in Tower A" }
```

- **`package`** is a complete one-sheet `.drawing` JSON envelope. The editor opens it as it opens a file:
  `openSource({ name, bytes: new TextEncoder().encode(JSON.stringify(msg.package)) })`. Sheet ids are Revit element
  ids, which stay stable when a sheet is renumbered. Element ids are Revit element ids too, so `hostRef`,
  `hostWallRef` and `delete.targets` point straight at model elements.
- **`version`** counts per sheet from 1, and only goes up when the exported package differs from the last one.
  Versions restart when the plugin restarts. `server.epoch` tells the editor that this happened.
- **`stale`** is true when `baseVersion` was older than the plugin's current version, meaning the model changed
  under the editor. The commands were still applied: they are in sheet coordinates, which a model edit does not move.
  The editor decides whether to warn.
- **Result `status`**: `applied`; `skipped` (nothing wrong with the model: the command id was already applied, or the
  targets were already gone); `failed` (with `message`). `notes` say what was approximated. For a delete,
  `elementIds` are the elements removed.
- **`reason`**: `open`, `apply`, `revert`, `model_changed` (edited in Revit, or by another editor's apply on another
  sheet that shows the same elements).

## Error codes

`bad_message` (not JSON or a field is missing, named in `message`), `unknown_type`, `hello_required`,
`protocol_mismatch` (sent before the plugin closes the socket), `unknown_sheet`, `host_error` (the host threw an
exception; `message` holds its text). An error never closes the connection, except `protocol_mismatch`.

## How commands land in Revit

- The sheet point is turned into Revit sheet feet through the **title block** extent (the PDF page). Then it goes
  through the **plan viewport** under it (the smallest one, if they overlap) into model coordinates, using
  `Viewport.GetProjectionToSheetTransform` and `View.GetModelToProjectionTransforms`. Rotated and scaled plans work.
  A command that falls outside every plan viewport fails.
- `create_wall`: one straight wall per path segment, plus the closing segment for a closed path. It goes on the view's
  level, and its height runs to the next level up (10 ft when there is none). `wallType` is matched by name, and
  falls back to the model's default wall type.
- `place_door`: the door is hosted in `hostWallRef` (a Revit id, a `wall-<id>` context id, or the `cmd-…` id of a wall
  this link created). Otherwise it goes in the nearest wall within 2 ft. Its type is matched by `familyType` as
  `Family: Type` or by type name, else the type closest in width.
- `place_instance`: a Furniture family, matched like doors (by width and depth), then rotated.
- `delete`: targets that are Revit ids, `wall-<id>`-style context ids, or command ids of this link. Inferred ids
  (from a plain PDF) cannot be resolved and are listed in `notes`.
- `set_type`: `ChangeTypeId` on each target. The type is looked up among the types the element can take
  (`Element.GetValidTypes`: its category, and its kind for walls): by `family` and `typeName`, or with no `family` by
  `typeName` as the type name or as `Family: Type` (a `typeName` that already starts with `family: ` is read as that
  key); then the same ignoring case. When none matches, the closest match is a type of that name in another family,
  applied with a note (`no Doors type 'X: Y', used 'Z: Y'`). With no such type the command fails, and `message` lists
  the types there are. `elementIds` are the elements retyped; a target that is missing or cannot take the type is a
  note, and the command fails only when no target can.
- The whole batch is one Undo step in Revit. Each command runs in its own transaction, so a command Revit rejects
  rolls back alone. Revit warnings do not open dialogs: they come back as `notes`.
- `revert` deletes what the given commands created. For a `set_type` it puts back the type each element had before,
  on the elements that still have the type the command gave them (an element retyped since, in Revit or by a later
  command, is left as it is and named in `notes`; if none is put back the result is `skipped`). Deletes cannot be
  reverted through the link; the user can use Undo in Revit.
