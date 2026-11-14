# 0002 `.drawing` package manifest (context interface)

Date: 2026-11-14

The Exporter teammate plugs into the Editor through one JSON manifest per package, typed in
`src/core/context/package-format.ts`. `contextFromPackage(manifest, sheetId?)` turns one sheet of it into the
frozen `SheetContext` (`origin: 'package'`, every item `confidence: 1`, `hostRef` = element id).
`sheetsFromPackage(manifest)` yields the `Sheet[]`, and `paletteFromPackage(manifest)` the type palette.

```jsonc
{
  "schemaVersion": 1,
  "project": "Tower A",
  "palette": {                       // optional; built-in DEFAULT_PALETTE fills any missing list
    "walls":     [{ "name": "Generic - 200mm", "thicknessMm": 200 }],
    "doors":     [{ "name": "Single-Flush 0900x2100", "widthMm": 900, "heightMm": 2100 }],
    "furniture": [{ "name": "Desk 1600x800", "widthMm": 1600, "depthMm": 800 }]
  },
  "sheets": [{
    "id": "A-201", "number": "A-201", "name": "Level 2 Floor Plan",
    "sizePt": { "w": 2384, "h": 1684 }, "scale": 100,
    "elements": [
      { "id": "123456", "category": "Walls", "typeName": "Generic - 200mm",
        "footprint": [{ "x": 100, "y": 100 }, { "x": 400, "y": 100 }] },
      { "id": "123470", "category": "Doors", "typeName": "Single-Flush 0900x2100",
        "footprint": [{ "x": 200, "y": 100 }, { "x": 225, "y": 100 }] },
      { "id": "123480", "category": "Rooms", "label": "OFFICE 201",
        "footprint": [{ "x": 104, "y": 104 }, { "x": 396, "y": 104 }, { "x": 396, "y": 296 }, { "x": 104, "y": 296 }] }
    ]
  }]
}
```

Rules:

- Coordinates are sheet points, origin top-left, y down (same as `core/types`).
- Footprints: Walls and Grids are centerline polylines (open). Doors and Windows are the opening segment or
  outline. Rooms, Furniture and Casework are closed polygons. `closed` overrides.
- Category mapping: Walls to `wall`, Doors and Windows to `opening`, Grids to `grid`, Furniture and Casework to
  `fixture`, Text to `label`, Rooms to `unknown` with `props.role = 'room'` (what `roomAt` reads), anything else
  to `unknown`. `props.category` and `props.typeName` always carry the host values.
- Item id is `${kind}-${element.id}`. `hostRef` is `element.id`.
- Unknown categories are accepted as strings and become `unknown` items.
