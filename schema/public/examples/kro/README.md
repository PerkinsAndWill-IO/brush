# KRO sample drawing

`kro-sample.drawing` is exported from a Perkins&Will project model (KRO, Revit 2026) to test the Editor on a large real
project. It is in the current `.drawing` format (version 1, zstd frames, `schema/schema/drawing-format.md`) and replaces
the earlier legacy `kro-test.drawing` and `kro-test-lean.drawing`.

| Sheet | Content |
|---|---|
| KRO-APD-ARC-PLN-A1A-N01-0001 | plan |
| KRO-APD-ARC-ELE-A1A-TTN-0032 | elevation |
| KRO-APD-ARC-DET-A1A-TTN-0053 | detail |
| KRO-APD-ARC-SYN-A1A-TTN-0061 | synthesis (axonometric) |

The file is about 3.5 MB and a regular git file, not Git LFS (see `schema/.gitattributes`), so deployments that skip LFS,
such as Vercel, still offer it in the Editor's sample picker. Other `.drawing` files in this folder are LFS objects.

## Licence

Project data of Perkins&Will, approved for publication in this public repository. It is not covered by the code licence
of this repository and is not the CC BY-NC-SA sample of `../house.drawing`. No Revit model is distributed here.
