# KRO test drawings

Exported from a Perkins&Will project model (KRO, Revit 2026) for testing the viewer and the editor on a large real
project. Project data, not covered by the repository licence.

| File | Pages |
|---|---|
| `kro-test.drawing` | KRO-APD-ARC-PLN-A1A-N01-0001 (plan), KRO-APD-ARC-ELE-A1A-TTN-0032 (elevation), KRO-APD-ARC-SYN-A1A-TTN-0061 (synthesis) |
| `kro-test-lean.drawing` | The same three sheets, a leaner export (12 MB instead of 30 MB) |

`kro-test.drawing` is stored with Git LFS: run `git lfs pull` after cloning. `kro-test-lean.drawing` is a regular file, so
deployments that skip LFS still offer it. The files appear in the editor's sample picker (a file not yet
pulled is left out). Open in the viewer with `?file=/examples/kro/kro-test.drawing`.

Known gaps of this export: some floor bands and facade panels on 0032 are drawn as dense black hairlines, and room
tags on 0001 overlap.
