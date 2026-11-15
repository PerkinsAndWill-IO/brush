# M6 — Live link to Revit

**Goal:** the editor connects to the Brush Link Revit add-in (`revit/` in this repo). Committed commands are applied in
Revit as you draw, and the sheet comes back as a new `.drawing` version that replaces the one on screen.
**Exit:** with the DevHost running (`cd ../revit && dotnet run --project src/Brush.Link.DevHost`), drawing a wall on
the fixture sheet shows `applied` for it, and the board reloads the sheet at version 2 with the new wall in its context.
**Lanes:** Canvas (`src/app/revit/**`, UI, test API). No `core` change: the protocol is I/O, so it lives in `app`.
**Protocol:** [`../../../revit/docs/protocol.md`](../../../revit/docs/protocol.md). The plugin side is built and tested.

| ID | Requirement | Acceptance test |
|---|---|---|
| M6-01 | `RevitLink` client (`src/app/revit/link.ts`) connects to `ws://127.0.0.1:47821/link`, sends `hello`, exposes `welcome.sheets`, reconnects with backoff, and reports state `off | connecting | on | refused`. | Unit test against a fake socket |
| M6-02 | **Open from Revit**: a toolbar entry lists the welcome's sheets; picking one sends `open_sheet` and opens the returned `package` through `openSource({ name, bytes })`. | E2E with the DevHost |
| M6-03 | Commands appended to the `CommandLog` while linked are sent in an `apply` batch (debounced, e.g. 300 ms after the last commit) with `baseVersion` = the version on screen. | E2E: draw a wall, see `applied` |
| M6-04 | A `sheet` push for the open sheet replaces the source, keeping camera and tool, and clears strokes whose commands came back `applied`. A newer `version` always wins. | E2E: version 2 has the wall as package context |
| M6-05 | Per-command results show on the ink: failed shows the message, and notes show as a hint. | E2E screenshot |
| M6-06 | Undo of a stroke whose commands were applied sends `revert` with their ids. | E2E: undo, version 3 has no wall |
| M6-07 | Pushes with `reason: "model_changed"` (edited in Revit) reload the sheet. In-flight strokes stay. | E2E: DevHost `rm`, board updates |
| M6-08 | Before the first connect from a deployed (https) editor, explain Chrome's local-network prompt and the Revit "allow this page" dialog. | Screenshot |
| M6-10 | **Open several sheets at once**: the panel's sheet list has a checkbox per sheet that is not open yet (and "Select all"); "Open N sheets" (or "Add N sheets" when some are open) sends one `open_sheet` per sheet, and all of them land on one board in list order. Only the first is shown in Revit. | E2E with a mocked socket: pick 2 of 3, both open |

Notes:

- Sheet ids from Revit are element ids (`"382617"`); the number is in `sheets[].number`. Commands must carry the id.
- The DevHost needs the .NET 8 SDK. E2E tests that use it should skip with a clear message when `dotnet` is missing,
  rather than fail.
- No new dependency: the browser `WebSocket` is enough.

## Status

Built in `src/app/revit/`: `link.ts` (socket client, M6-01), `sync.ts` (log ↔ model diff: apply, revert, landed),
`source.ts` (`RevitSource`, one part per Revit sheet), `controller.ts` (glue, React store), `RevitPanel.tsx` (top-bar
button and panel, start-page entry, M6-08 explainer, M6-05 results HUD). Tests: `tests/unit/revit/*`,
`tests/e2e/m6-revit-link.spec.ts` (DevHost test skips without `dotnet`; M6-05 and M6-08 use a mocked socket).

How it behaves:

- Several Revit sheets can be open at once (panel → Add, or tick several and "Open N sheets", M6-10). A `sheet` push replaces only that sheet: the other
  sheets, the camera, the tool and the strokes stay; contexts of the replaced sheet are rebuilt.
- The command log is the truth. Commands in the log the model has not seen are applied; applied commands that left
  the log (undo, erase) are reverted; redo applies them again. Failed commands stay failed until removed.
- A stroke is hidden (not erased: it stays in the history) once all its commands are applied and a newer sheet
  version arrived. Undo still reaches it.
- A linked session has no sidecar (the model is the record), and its command ids carry a session prefix
  (`cmd-k3f9x2-0001`), because the plugin remembers applied ids for as long as Revit runs.
- Drawn while disconnected: commands wait and go out on reconnect. Replies lost in a drop are resent (the plugin
  answers `skipped` for ids it already has). A new server `epoch` resets versions and re-opens the sheets.
- DevHost limit: it sends the same PDF every version (only the manifest changes), so a landed wall is in the
  context but not drawn. Revit re-exports the PDF.
