# revit: Brush Link for Revit

A Revit add-in that the Brush Editor connects to while you sketch. The editor sends its commands (walls, doors,
furniture, deletes) and Revit applies them to the open model. The sheet then goes back to the editor as a new
`.drawing` version, and edits made in Revit itself are pushed the same way.

```text
Brush Editor (browser)  ── apply {commands} ──▶  Brush Link (Revit add-in)  ──▶  Revit model
        ▲                                               │
        └──────── sheet {version, .drawing package} ────┘   (also on edits made in Revit)
```

Protocol: [`docs/protocol.md`](docs/protocol.md). Why it is built this way: [`docs/decisions/0001-live-link.md`](docs/decisions/0001-live-link.md).

## Layout

| Project | What | Runs on |
|---|---|---|
| `src/Brush.Link.Core` | Protocol, loopback WebSocket server, sheet ↔ model math, command planner, `.drawing` writer, `PackageHost` (in-memory stand-in for Revit). No Revit, no dependencies. | any OS, .NET 8 |
| `src/Brush.Revit` | The add-in: ribbon button, API-thread dispatcher, reads sheets/viewports/elements, exports PDF, applies commands. | Windows, Revit 2025–2027 |
| `src/Brush.Link.DevHost` | The link without Revit: serves an editor `.drawing` package and applies commands to its manifest. For editor work on any machine. | any OS |
| `tests/Brush.Link.Core.Tests` | Unit tests, plus end-to-end tests over a real socket against the editor's fixture package. | any OS |

## Build and test

You need the .NET 8 SDK (and the .NET 10 SDK to build for Revit 2027). Run everything from `revit/`:

```sh
dotnet build                     # everything; the add-in compiles on Linux and macOS too (Revit API reference packages)
dotnet test                      # core tests, including the socket round trip
```

## Try it without Revit

```sh
dotnet run --project src/Brush.Link.DevHost                         # serves tests/fixtures/office-1-sheet.json.drawing
dotnet run --project src/Brush.Link.DevHost -- path/to/x.drawing --allow-origin https://brush-editor.example
```

Then connect from the editor (`pnpm dev`, port 5173, is allowed by default). In the DevHost console, `rm <sheetId>
<elementId>` simulates an edit made in Revit: every editor with that sheet open gets a new version.

## Install in Revit (Windows)

```sh
dotnet build src/Brush.Revit -c Release                         # Revit 2026 (default)
dotnet build src/Brush.Revit -c Release -p:RevitVersion=2025    # or 2027
```

A Windows build copies `Brush.Revit.addin` and a `Brush\` folder into `%APPDATA%\Autodesk\Revit\Addins\<year>\`
(`-p:DeployToRevit=false` to skip). Start Revit and open a model. The link starts by itself. **Add-Ins → Brush → Brush
Link** shows its status and turns it on or off.

Settings, all optional, in `%APPDATA%\Brush\revit-link.json`:

```json
{
  "port": 47821,
  "autoStart": true,
  "allowedOrigins": ["http://localhost:5173", "https://brush-editor.example"],
  "allowMissingOrigin": true,
  "modelChangeDebounceMs": 600
}
```

Log: `%LOCALAPPDATA%\Brush\revit-link.log`.

## Status and limits (v0.1)

Verified here: the core (36 tests, including socket round trips and origin and host checks), a real Chromium page on
`localhost:5173` talking to the DevHost, and the add-in compiling against the Revit 2025, 2026 and 2027 APIs.

**Not yet run inside Revit.** The Revit layer compiles against the real API but has not met a model. Check these
first on a real project:

- The PDF page matches the title-block extent, so the manifest overlays the PDF. If they disagree,
  `SheetReader.FrameOf` is the place to fix it.
- Sheet coordinates map to model coordinates through rotated or cropped plans (`SheetReader.GeometryOf`).
- Door and furniture type matching works on a real family library.

Known limits:

- Only plan viewports take edits. Sections, elevations and 3D views are exported in the PDF only.
- For a view with a split crop region, only the first region's transform is used.
- Walls are straight segments. Arcs in the editor path come through as their polyline.
- A `delete` cannot be reverted from the editor (use Undo in Revit). Element ids recorded per command are kept only for
  the Revit session.
- Every model change re-exports every open sheet. Exports that did not change are not pushed, but they still cost
  Revit time.
- The sheet goes back as the editor's JSON-envelope package (manifest + PDF), which the editor now treats as legacy.
  The editor reads the binary `.drawing` since its decision 0008; sending that instead is the next format step (see
  decision 0001).
- The link works on the active document. Switching documents changes the sheet list, and the editor gets a `sheets`
  message.
