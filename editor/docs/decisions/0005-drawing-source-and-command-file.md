# 0005 DrawingSource, `.drawing` container and the command file

Date: 2026-11-14

## Context

Two inputs, one shape (spec "Inputs and document model"): a plain PDF (context inferred) and a `.drawing`
package (context from the host model, manifest in decision 0002). M5 adds the command export the future Applier reads.

## Decision 1: container, no new dependency

The manifest (0002) is the contract; the container is not. The reader (`src/app/source/package-file.ts`) sniffs by content:

1. **JSON envelope** (what we write and the fixtures use): the manifest at the top level plus
   `"pdf": { "name", "encoding": "base64", "data" }`. Zero dependencies, diffable, trivially produced by any exporter.
2. **ZIP** (what an Exporter may prefer for size): `manifest.json` (or `drawing.json`) plus one `*.pdf`
   (named by `pdf.path` in the manifest, else the first `.pdf`). Stored or deflate; deflate uses the platform
   `DecompressionStream('deflate-raw')`. No zip library.
3. **Bare manifest JSON** with optional `pdf: { href }` (linked PDF, resolved relative to the package URL).

Alternative considered: a zip library (fflate/jszip). Rejected: ~40 lines of reader cover stored and deflate.
Base64 costs 33% size, acceptable for fixtures; real packages can ship as zip. The reader is tolerant (unknown keys
ignored, missing `elements` is empty); only a bad `schemaVersion` or missing `sheets` is an error. The PDF is for
display only; sheets and context come from the manifest, and the page count must be at least the sheet count.

## Decision 2: `DrawingSource` (`src/app/source`)

`PdfDrawingSource` (pdf.js sheets, context worker, `origin: 'inferred'`, `DEFAULT_PALETTE`) and
`PackageDrawingSource` (manifest sheets, `contextFromPackage`: origin `package`, confidence 1, `hostRef`, palette from
the manifest). `openSource(file | {name, bytes} | url)` sniffs. Packages use the manifest sheet ids (e.g. `A-101`);
PDFs use `sheet-<i>`. Commands carry the sheet id of their source.

## Decision 3: command file `<name>.commands.json`

```jsonc
{
  "schemaVersion": 1,
  "kind": "brush-commands",
  "source": { "name": "plan.drawing", "kind": "package", "project": "Tower A" },  // kind: "pdf" | "package"
  "sheets": [{ "id": "A-101", "number": "A-101", "name": "Level 1 Floor Plan", "scale": 100 }],
  "commands": [ /* core/types Command[], in log order; ids cmd-0001...; strokeId links back to the sidecar */ ],
  "exportedAt": 1731600000000                      // optional epoch ms (omitted for deterministic output)
}
```

Command semantics are those of `core/commands` (`create_wall.path`, `place_door.at/widthPt/angleRad/hostWallRef`,
`place_instance.at/bbox/angleRad/family`, `delete.targets`); coordinates are sheet points, top-left origin, y down.
For package sources `hostWallRef` and `delete.targets` are host element ids; for plain PDFs they are inferred item ids
(the Applier must treat those as geometric hints). `commands.json` is written next to the PDF as
`<name>.commands.json` (`commandFileName`); until the platform adapter can write there (the Tauri fs scope allows only
`*.brush.json`), `writeCommandFile` goes through `platform.saveTextFile` (a download).

## Consequences

Fixture packages: `scripts/fixtures/gen-package.mjs` builds `fixtures/packages/*.drawing` and `*.idmap.json`
(truth id to host id, used only to derive expected host refs). M5 exit check: `tests/eval/run-commands.ts`,
golden labels in `fixtures/expected-commands/`.
