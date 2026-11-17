Read and follow `AGENTS.md` in this folder (`editor/`). It holds the rules, commands, definition of done and lane ownership for the Brush Editor. Run all commands from `editor/`.

## Conversion server (`.rvt` → `.drawing`)

Opening a `.rvt` sends it to a conversion server (`src/app/converter.ts`, `src/app/store.ts`,
`src/app/convertClient.ts`; `VITE_RVT_CONVERT_URL`, defaulting to `http://127.0.0.1:4100/convert` in dev and test only).
It is not deployed: a production build without `VITE_RVT_CONVERT_URL` tells people `.rvt` is not available yet. That server lives in its own repo:
https://github.com/PerkinsAndWill-IO/rvt-rs-sheets (`scripts/convert-server.mjs`, wrapping the `rvt` CLI). Its README
documents the HTTP contract. To run it locally next to `pnpm dev`:

```bash
gh repo clone PerkinsAndWill-IO/rvt-rs-sheets ../../rvt-rs-sheets
cd ../../rvt-rs-sheets && cargo build --release -p rvt-cli
RVT_BIN=target/release/rvt ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 node scripts/convert-server.mjs
```

`ALLOW_ORIGINS` is needed because the server's default CORS list does not include the editor's port 5173.
