# 0007 Web app first; Tauri shell parked

Date: 2026-11-14

## Decision

For the hackathon the Editor ships as a web app: `pnpm dev` locally, a Vercel deployment for the demo. The Tauri shell in `src-tauri/` stays in the repo but is parked: not built in CI, not part of `pnpm verify`, not used for the demo.

## Why

- All logic already lives in TypeScript (`src/core`, `src/app`); every test, eval and screenshot runs in Chromium. Tauri added no capability we use yet.
- Saves the Rust build and packaging loop, a second runtime to test (the spec's pen pressure and latency risk for WebView2), and desktop permissions and CSP work.
- The hosted second pass needs a server-side key anyway. A same-origin Vercel Function (`api/ai-gateway.ts`) is simpler than a desktop proxy.
- Sharing is a URL instead of an installer.

## Alternative considered

Keep Tauri as the primary target (spec "Architecture and stack"). Rejected for the weekend: cost without benefit. Revisit if the desktop wins something concrete (silent sidecar writes, offline use, OS pen APIs).

## Consequences

- The sidecar `<name>.brush.json` cannot be written silently next to the PDF. The browser keeps autosaving to browser storage; in Chromium, the File System Access API can save next to the file after one permission prompt.
- `api/ai-gateway.ts` proxies only POST Messages for an allow-list of Haiku models with a max_tokens cap, using Vercel OIDC or a project env var. Previews keep Deployment Protection on.
- Vercel project `perkinswill/brush-editor` (root directory `editor`) builds previews from Git; `ignoreCommand` skips commits that do not touch `editor/`.
