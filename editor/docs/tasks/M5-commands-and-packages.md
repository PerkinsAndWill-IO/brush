# M5 — Commands and packages

**Goal:** command log out; `.drawing` package in when the Exporter delivers one.
**Exit:** the same stroke corpus produces the expected command list from a package and from a plain PDF.
**Lanes:** Commands (`src/core/commands`), Context (package to `SheetContext`), Canvas (log UI, `commands()` test API).

| ID | Requirement | Acceptance test |
|---|---|---|
| M5-01 | Committed decisions emit neutral commands: wall `create_wall`, door `place_door`, furniture `place_instance`, delete `delete`, markup none. | Unit test per kind |
| M5-02 | The command log is written to the session sidecar (`SessionFile.commands`) and readable via `commands()`. | E2E reload test |
| M5-03 | A `.drawing` package loads through the same `DrawingSource` interface; context `origin: 'package'`, confidence 1, `hostRef` set. | Unit test with a package fixture |
| M5-04 | Delete and door commands reference host ids (`hostRef` / `hostWallRef`) when from a package. | Unit test |
| M5-08 | A binary `.drawing` (`schema/schema/drawing-format-legacy.md`) opens through `openSource`: pages drawn from its vectors, sheets in viewer order, broken files rejected naming page/item/field (decision 0008). | `tests/unit/drawing/format.test.ts`, `tests/unit/source/drawing-source.test.ts`, `tests/e2e/m5-drawing.spec.ts` |
| M5-09 | Context and palette from a `.drawing`'s elements: walls, openings on host walls, rooms, fixtures, grids, labels with `hostRef`; scale estimated; model types in the palette. | `tests/unit/context/drawing.test.ts` |
| M5-05 | Corpus replay produces the expected op per recording (`expectedOp`, derived from the label if absent), from a package and from a plain PDF. | Eval: command-op match table |

Depends on the Exporter; can slip without hurting the demo.
