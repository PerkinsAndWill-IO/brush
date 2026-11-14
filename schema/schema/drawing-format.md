# The `.drawing` format, version 1

This format keeps the meaning of every page, item and element of the [legacy gzip format](drawing-format-legacy.md). It
changes the container so that a file is about a third of the size, and a reader can show the first page without
decoding the rest. Readers keep reading the legacy format.

A reader tells the two apart by the first bytes, not by the version number: a gzip stream starts with `1f 8b`, this
format with the raw magic `DRAWING\0`. (The legacy payload also carries version 1, inside the gzip.)

What changes from the legacy format:

- **No gzip around the file.** Each page and the elements table are separate zstd frames, and the header has an index
  of them.
- **Coordinates are quantised integers.** They are `i32` in units of 0.01 mm on paper, delta-coded within each blob.
- **Per-page element boxes,** for culling and picking without scanning points.

## Container

The file, integers little-endian:

| Bytes | Content |
| --- | --- |
| 8 | magic `DRAWING\0` |
| 4 | `u32` version, 1 |
| 4 | `u32` H, the header length in bytes |
| H | the header: UTF-8 JSON, not compressed |
| rest | **frames**: each one independent zstd frame |

A **frame reference** is `[byteOffset, byteLength]` counted from the start of the file. Frames may come in any order,
and bytes outside them are ignored. A reader can therefore fetch the header and one page's frame with HTTP range
requests.

## Header

```json
{
  "format": "drawing", "version": 1,
  "source": {"file": "model.rvt", "generator": "..."},
  "unitsPerFoot": 30480,
  "pages": [
    {"id": 382617, "kind": "sheet", "number": "A102", "name": "Plans", "scale": null, "min": [0, 0], "max": [2.76, 1.95], "frame": [1024, 5032112]}
  ],
  "elements": [5033136, 96210]
}
```

- `pages`: the legacy page fields without `items`. `frame` is the page frame.
- `unitsPerFoot` is 30480, which makes one unit 0.01 mm of paper. Readers reject any other value.
- `elements` is the frame of the elements table. Its content is the UTF-8 JSON object that was `elements` in
  the legacy format. A reader may load it after the first page is drawn: only the metadata card, filters and context need it.

## Page frame

Decompressed, a page frame is laid out like a legacy payload without the magic and version:

| Bytes | Content |
| --- | --- |
| 4 | `u32` J, the page JSON length |
| J | the page JSON |
| 0-3 | zero padding to the next multiple of 4, counted from the start of the frame |
| rest | the **buffer**: blobs, each starting at a multiple of 4 from the buffer start |

The page JSON:

```json
{"items": [], "boxes": {"12345": [x0, y0, x1, y1]}}
```

- **`items`:** legacy items, in draw order, with the same blob reference fields (`pts`, `segs`, `rings`, `png`).
  `text` items are unchanged: their coordinates stay JSON numbers in paper feet.
- **`boxes`:** for each element that has items on this page, the bounding box of its geometry (stroke points, segment
  ends, fill rings and image rectangles; text anchors may be left out). Coordinates are integers in units, relative to
  the page `min`.

### Coordinate blobs

A coordinate blob is `i32` values in units relative to the page `min`, so `x = min[0] + X / unitsPerFoot`, and the same
for y. Each blob is delta-coded on its own:

| Blob | Stored values | Decoding |
| --- | --- | --- |
| `pts`, and each ring of `rings` | `X0, Y0, dX1, dY1, ...` | point k = point k-1 + d |
| `segs` | per segment `dsx, dsy, dex, dey` | start = previous segment's end + ds (the first segment's start is ds itself); end = start + de |

The decoded values are the same as the legacy format's (paper feet, x right, y up), within half a unit (0.005 mm on paper).
Lengths follow the legacy format: `pts` and ring blobs are a multiple of 8 bytes, and `segs` blobs a multiple of 16. `png` blobs
are PNG file bytes, as in the legacy format.

## Writing

- Writers round each coordinate to a unit before delta coding, and code each delta from the previous rounded value, so
  rounding errors do not accumulate.
- Use zstd level 9 or higher. Level 19 makes files smaller and costs only writing time.
- Each page frame holds only that page's blobs. The same blob may be used twice within one page.

## Reading rules

The legacy format's rules apply within each page frame, plus these:

- A frame outside the file is rejected, naming the page or `elements`.
- A frame that does not decompress is rejected the same way.
- An `unitsPerFoot` other than 30480 is rejected.
- A box that is not four integers is rejected.
- A decoded coordinate that overflows `i32` is rejected.

Readers produce the same in-memory pages from legacy and current files.
