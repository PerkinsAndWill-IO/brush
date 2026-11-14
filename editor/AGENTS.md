# Brush Editor — agent instructions

These are the instructions for the **Editor** (`editor/` in the brush repo). Other folders of the repo
belong to other teams; do not edit them from an Editor task. **Run every command from `editor/`.**

The spec is `docs/spec.md`. Shared contracts are `src/core/types/index.ts` (frozen).

## Rules

1. **Work from a task file** in `docs/tasks/`. If a task has no acceptance test, write the test first, and stop for review if the requirement is unclear.
2. **Done means `pnpm verify` is green.** Report the eval table (`reports/eval.json`) and any screenshots you produced (`reports/screens/*.png`).
3. **Never weaken a test, a budget or a threshold to get to green.** Propose the change in the task file and wait for a human. Budgets live in `scripts/budgets.ts`.
4. **`core` stays pure:** no DOM, no React, no network. If a feature needs one of those, it belongs in `app`. ESLint enforces this for `src/core/**`.
5. **Types in `core/types` are contracts.** Changing one needs a decision record in `docs/decisions/` and updates to every consumer in the same change.
6. **No new dependency without a decision record** naming the alternative considered. Versions are pinned exactly (no `^`).
7. **Small commits**, one requirement ID per commit message where possible (e.g. `M1-07: store strokes in sheet coords`).
8. **Before using tldraw, pdf.js or Tauri APIs, read the docs for the pinned version** — in `node_modules` (`tldraw/DOCS.md`, `tldraw/RELEASE_NOTES.md`, `pdfjs-dist/types/**`, `@tauri-apps/*/dist-js/*.d.ts`). Do not code these from memory.
9. **Model keys live in `.env.local`** and are never committed. Tests use cassettes (`fixtures/cassettes/`).

## Commands (from `editor/`)

| Command | Does | Target time |
|---|---|---|
| `pnpm dev` | Runs the app in a browser tab with hot reload (http://localhost:5173) | instant reloads |
| `pnpm check` | Typecheck, lint, core unit tests (`tests/unit/**`, Vitest, node) | under 30 s |
| `pnpm e2e` | Playwright on Chromium (`tests/e2e/**`), screenshots to `reports/screens` | a few minutes |
| `pnpm eval` | Replays `fixtures/strokes/**` through `core/predict`, writes `reports/eval.json` | under 1 min |
| `pnpm verify` | check + e2e + eval + budget gates (`scripts/verify.ts`). **Definition of done.** | under 5 min |
| `pnpm app` | Runs the Tauri shell (`tauri dev`), for humans | n/a |

Sub-steps: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm budgets` (gates only, reads existing reports).
First-time setup: `pnpm install` then `pnpm exec playwright install chromium`.

## Driving the app (agents and tests)

- The app runs as a plain web page. In dev/test builds it exposes `window.__brush` (`BrushTestApi` in `src/core/types`).
  It is not present in production builds.
- Fixtures are served by the Vite dev server at `/fixtures/*` (plugin in `vite.config.ts`, dev/preview only), so
  `await window.__brush.loadPdf('/fixtures/pdfs/office-1-sheet.pdf')` works in tests and in `pnpm dev`.
- `loadPdf` resolves after the first page is painted. Read state as data (`sheets()`, `strokes()`, `hypotheses()`),
  never only from pixels.
- Every e2e test saves a screenshot via `screenPath(name)` from `tests/e2e/helpers.ts`. Open them to judge visual
  work against `docs/design/project/*.dc.html`.
- Perf numbers go to `reports/perf.json` via `recordPerf({ key: value })`; keys must match `scripts/budgets.ts`.
- Library smoke pages: `/?smoke=tldraw` mounts tldraw.

## Definition of done

- `pnpm verify` exits 0: typecheck, lint, unit, e2e, eval all pass and every budget **with data** passes.
  Budgets without data print `pending (Mx)` and do not fail.
- New behavior has a test that cites its requirement ID (`M1-07` etc.) in the test name.
- Report: the requirement IDs covered, the eval table, the screenshot paths.

## Lanes (who owns which files)

| Lane | Owns |
|---|---|
| Harness | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root configs (`tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.js`), `index.html`, `scripts/**` (except `scripts/fixtures`), `tests/e2e/helpers.ts`, `tests/e2e/global-setup.ts`, `tests/eval/**`, `src-tauri/**`, `AGENTS.md`, `CLAUDE.md`, `docs/tasks/**`, CI workflow. Only this lane runs `pnpm add` / `pnpm install`. |
| Fixtures | `scripts/fixtures/**`, `fixtures/**` |
| Canvas | `src/app/**` (board, sheets, PDF rendering, tools, sidebars, test API), its e2e specs |
| Stroke core | `src/core/geometry/**`, `src/core/stroke/**`, `tests/unit/geometry/**`, `tests/unit/stroke/**` |
| Context | `src/core/context/**`, `tests/unit/context/**` |
| Predict | `src/core/predict/**` (incl. `eval-entry.ts`), `tests/unit/predict/**` |
| Commands | `src/core/commands/**`, `tests/unit/commands/**` |
| Humans | `src/core/types/**` (frozen), `docs/spec.md`, `docs/decisions/**`, budgets |

## Layout

```text
src/core/      pure TS: types, geometry, stroke, context, predict, commands
src/app/       React UI, pdf.js wrapper (pdf/), platform adapter (platform/), test API (testApi.ts)
src-tauri/     Tauri 2 shell: window, dialog + fs plugins, file drop. No app logic.
fixtures/      pdfs/, strokes/, contexts/ (optional precomputed SheetContext for eval), cassettes/
tests/unit/    Vitest, core only        tests/e2e/   Playwright        tests/eval/  run-eval.ts
reports/       generated, not committed: screens/, eval.json, perf.json, budgets.json
```
