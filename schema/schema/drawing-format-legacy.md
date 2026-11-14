# The `.drawing` format, legacy gzip

This is the legacy gzip format. Existing files are in it; new files use the [zstd format](drawing-format.md). The
payload's version field is literally 1 in these files and stays 1. A reader tells the formats apart by the first bytes:
a gzip stream starts with `1f 8b`, the zstd format with the raw magic `DRAWING\0`, whatever the version number.

A `.drawing` file holds several pages (sheets and views) of 2D drawings, with the metadata of the elements the items
belong to. The viewer owns this format; whatever writes it (an extractor, a converter) follows this document.

Machine-readable header: [`drawing.schema.json`](drawing.schema.json) (JSON Schema draft 2020-12). It reuses the
element, point, colour and id definitions of [`scene.schema.json`](scene.schema.json), so item fields mean what they mean
in the scene JSON, except that bulk data is stored as blobs.

## Container

The file is a **gzip stream** of the payload. Readers decompress it with the browser's `DecompressionStream('gzip')`.

The payload, integers little-endian:

| Bytes | Content |
| --- | --- |
| 8 | magic `DRAWING\0` |
| 4 | `u32` version, 1 |
| 4 | `u32` H, the header length in bytes |
| H | the header: UTF-8 JSON |
| 0-3 | zero padding to the next multiple of 4, counted from the start of the payload |
| rest | the **buffer**: blobs, each starting at a multiple of 4 from the buffer start |

A **blob reference** is `[byteOffset, byteLength]` relative to the buffer start. Blob offsets are multiples of 4, so a
reader can view a coordinate blob as a `Float32Array` straight into the decompressed buffer (and copies it when its own
memory is not aligned). Coordinate blobs are little-endian `f32`; image blobs are raw PNG file bytes. Two items may
point at the same blob. Unused bytes between blobs are ignored.

## Header

```json
{
  "format": "drawing", "version": 1,
  "source": {"file": "model.rvt", "generator": "..."},
  "pages": [
    {"id": 382617, "kind": "sheet", "number": "A102", "name": "Plans", "scale": null, "min": [0, 0], "max": [2.76, 1.95], "items": []},
    {"id": 960621, "kind": "view", "number": null, "name": "{3D}", "scale": "1 : 100", "min": [0, 0], "max": [4, 3], "items": []}
  ],
  "elements": {
    "12345": {"class": "...", "category": "...", "name": "...", "family": "...", "type": "...", "level": "...", "tagged": 857191, "params": [{"name": "...", "value": "..."}]}
  }
}
```

- Coordinates are paper feet, x right, y up. A page is the white rectangle `min`..`max` (it must have an area). Items are
  in draw order.
- `kind` is `sheet` or `view`. A sheet has a `number` and `name`; a view usually has no `number` and a `scale` text such
  as `"1 : 100"`. The viewer lists sheets first, then views, each group in file order, labelled `A102 Plans` and
  `{3D} (view)`.
- `elements` is shared by all pages. An item's `el` is a key of it (or `null`); `tagged` on an element refers to another
  element, whose card the viewer shows (see the scene contract in the README).
- An unknown `version` or a header that does not match the schema is rejected, naming the problem. Unknown item types
  are skipped.

### Items

The item types and fields of the scene contract (`path`, `segs`, `fill`, `text`, `image`; `w`, `c`, `dash`, `el`, `view`,
`anchor`, `dir`, ...), with these fields stored as blob references:

| Item | Field | Blob content |
| --- | --- | --- |
| `path` | `pts` | `f32` x,y per point (length a multiple of 8) |
| `segs` | `segs` | `f32` x0,y0,x1,y1 per segment (length a multiple of 16) |
| `fill` | `rings` | a list of blob references, one `f32` x,y list per ring (even-odd over all rings) |
| `image` | `png` | PNG file bytes (an image the browser cannot decode is skipped when drawing) |

`text` items are unchanged. Every coordinate must be finite.

## Reading rules the viewer enforces

Bad magic, a version other than 1, a header that overruns the file, a header that is not UTF-8 JSON of the right shape, a
blob outside the buffer, a blob offset that is not a multiple of 4, and a coordinate blob of the wrong length or with a
non-finite value each stop the load with a message that names the page, the item and
the field.
