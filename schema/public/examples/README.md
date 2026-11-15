# Example drawing

`house.drawing` is a three-page drawing in the current `.drawing` format (version 1, zstd frames, `schema/schema/drawing-format.md`):

- sheet A102, Plans
- sheet A103, Elevations and Sections
- a 3D (axonometric) view of the model

Every line, fill and text carries the element it came from, so hovering shows its card. Open it from the Editor's
sample picker. The old schema viewer reads only the legacy gzip format and keeps its own copy in `public/scenes/`.

`kro/kro-sample.drawing` is a second sample, from a real project (see `kro/README.md`).

## Licence

The drawing is derived from Autodesk's Revit 2026 basic sample project "rac_basic_sample_project", (c) Autodesk, which is
licensed under [Creative Commons Attribution-NonCommercial-ShareAlike 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/).

Changes were made: the sample's sheets and one view were converted to 2D drawing data.

This example file is redistributed under the same licence (CC BY-NC-SA 3.0), for non-commercial use only. It is not
covered by the code licence of this repository, and no other sample or project model is distributed here.
