
# Brush Editor: Software Spec

2026-11-14 · @Victor Barbosa


## Summary and scope

Brush Editor is a desktop app where an architect sketches on printed sheets and the brush predicts, while the pen is still moving, what building element is being drawn. This spec covers the Editor only, built in the [PerkinsAndWill-IO/brush](https://github.com/PerkinsAndWill-IO/brush) repo, largely by coding agents working against tests.

The hard problem, and the focus of this spec, is the contextual brush: reading the stroke, reading what surrounds it on the sheet, and turning both into a stable prediction fast enough to feel instant.

**In scope**

- Opening plain PDFs ("dumb" PDFs, no BIM metadata) and laying their pages out as sheets on one board.
- Sketching on those sheets: brush, eraser, pan, zoom, undo.
- Inferring context from the PDF itself: linework, text labels, grids.
- Predicting intent from stroke plus context, shown live as a ghost and a confidence readout.
- Emitting a neutral command list (`create_wall`, `place_instance`, `delete`) to a log.
- The agent harness: repo layout, commands, fixtures, tests and rules that let agents build and verify the app with little supervision.

**Out of scope**

- The Exporter and the enhanced `.drawing` package. A teammate owns these. The Editor defines the interface it will plug into and nothing more.
- Writing elements back into Revit or Rhino. Commands stop at a log until an Applier exists.
- Collaboration, accounts, cloud storage, mobile layouts.

**Milestone 1 is deliberately plain:** sketch on top of a PDF, with nothing happening magically. Every later milestone adds one layer of intelligence on top of that working base.


## Milestones

Six milestones, each shippable on its own and each gated by tests that an agent can run. M0 and M1 come first and contain no prediction at all.

| Milestone | What it adds | Exit criteria |
|---|---|---|
| M0 Harness | Repo scaffold, commands, fixtures, test API, CI, agent rules | `pnpm verify` is green on the empty app. An agent can launch the app headless, load a fixture PDF and save a screenshot. |
| M1 Sketch on PDF | Open a PDF, sheets on a board, pan and zoom, brush, eraser, undo, autosave, empty state | A replayed stroke lands on the right sheet, survives zoom and reload, and can be erased and undone. Ink latency is within budget. Nothing is predicted. |
| M2 Context | Vector and text extraction from the PDF, spatial index, snapping, a debug overlay of what was detected | On the fixture sheets, wall and grid candidates are found and a stroke end snaps to the expected point. |
| M3 Streaming prediction | Stroke fitting, features, rule-based hypotheses updated during the stroke, ghost preview, commit on pause | Top-1 accuracy and first-hypothesis latency meet the budgets on the labeled stroke corpus. |
| M4 Model second pass | Optional rescoring by a local or hosted model, confidence chips, the Reading panel | Accuracy on the ambiguous subset improves over M3, and no stroke ever waits on the model. |
| M5 Commands and packages | Command log out, `.drawing` package in when the Exporter delivers one | The same stroke corpus produces the expected command list from a package and from a plain PDF. |

For the hackathon weekend, M0 to M3 are the goal and M4 is the stretch. M5 depends on the Exporter and can slip without hurting the demo.


## Architecture and stack

The Editor is a web app in a thin desktop shell, with all intelligence in a pure TypeScript core that has no UI and no browser dependencies. That split is what lets agents test prediction headlessly, in milliseconds, without launching anything.

**Stack**

- **Shell:** Tauri 2. It only provides the window, file dialogs and file drop. No app logic in Rust.
- **UI:** Vite, React, TypeScript, pnpm. The app must also run as a plain web page, because that is how tests and agents drive it.
- **Canvas:** the tldraw SDK with its default UI hidden. It supplies the board, camera, undo history and ink rendering. Sheets and the brush are a custom shape and a custom tool.
- **PDF:** pdf.js (`pdfjs-dist`), used twice: to render each page as the sheet image, and to read the page's vector paths and text for context.
- **Tests:** Vitest for the core, Playwright on Chromium for the app. Chromium matches the WebView2 engine Tauri uses on Windows.

**Modules**

| Module | Responsibility | Depends on |
|---|---|---|
| `core/types` | Shared types and schemas: stroke, sheet context, hypothesis, command | nothing |
| `core/geometry` | Fitting lines, arcs and rectangles, resampling, spatial index, snapping | types |
| `core/stroke` | Stroke model, smoothing, feature extraction | geometry |
| `core/context` | Turns PDF paths and text, or a package manifest, into a sheet context | geometry |
| `core/predict` | Hypothesis engine, rules, stability, model adapters | stroke, context |
| `core/commands` | The command vocabulary and the log writer | types |
| `app` | React UI, tldraw integration, PDF rendering, the test API | all of core |
| `shell` | Tauri window, file open and drop | app |

**Rules that keep it testable**

- `core` never imports from `app`, React, tldraw, pdf.js or the DOM. Lint enforces this.
- Everything in `core/predict`'s first pass is a pure, deterministic function of stroke and context. The same input always gives the same hypotheses.
- Anything Tauri-specific sits behind a small `platform` adapter with a browser fallback, so the app behaves the same in a tab.
- Strokes are stored in sheet coordinates (PDF points), never in screen or board pixels. Zoom and layout can then change without touching the data.

**Decision to revisit:** tldraw saves the most time but needs a license key in a packaged production build, and agents may know an older version of its API. Pin the version, read its current docs before coding, and fall back to a plain `<canvas>` with a hand-written camera only if the custom brush tool fights the SDK.


## Inputs and document model

The Editor accepts a plain PDF today and an enhanced `.drawing` package later, and the rest of the app cannot tell the difference. Both are loaded through one interface that returns sheets and, for each sheet, a context.

**Two sources, one shape**

|  | Plain PDF (now) | `.drawing` package (later) |
|---|---|---|
| Sheets | One per PDF page, named from the page label or "Sheet N" | One per exported sheet, with number and name |
| Context | Inferred from the page's vector paths and text | Given by the Exporter: element footprints, IDs, types |
| Model coordinates | Unknown. Scale is read from text like "1:100" when present | Exact, from the sheet-to-model transform |
| Palette of types | A small built-in default list | The host model's own wall types and families |
| Confidence in context | Low to medium, every item carries a score | High |

The `.drawing` format itself is specified in `schema/schema/drawing-format.md`; how the Editor reads it into sheets and contexts is decision 0008.

**Core types**

```ts
interface DrawingSource {
  load(file: File): Promise<Sheet[]>
  contextFor(sheetId: string): Promise<SheetContext>
}

interface Sheet {
  id: string
  number?: string          // "A-201"
  name: string             // "Level 2 Floor Plan"
  sizePt: { w: number; h: number }   // PDF points, 1/72 in
  scale?: number           // 100 for 1:100, if known
}

interface SheetContext {
  sheetId: string
  origin: 'inferred' | 'package'
  items: ContextItem[]     // walls, grid lines, labels, fixtures
  // spatial queries live in core/geometry, not here
}

interface ContextItem {
  id: string
  kind: 'wall' | 'opening' | 'grid' | 'label' | 'fixture' | 'unknown'
  geometry: Path           // in sheet points
  text?: string            // for labels: "OFFICE 201"
  confidence: number       // 0..1, always 1 for package origin
  hostRef?: string         // element id, package origin only
  props?: Record<string, string>
}

interface Stroke {
  id: string
  sheetId: string
  points: { x: number; y: number; t: number; p?: number }[]  // sheet pts, ms, pressure
  tool: 'brush' | 'eraser'
  size: number
}
```

**Session file**

Work is autosaved to a sidecar next to the PDF, `<name>.brush.json`. It holds the strokes, the accepted predictions and the command log, plus a schema version. The PDF itself is never modified.

**What the Exporter teammate needs from this spec:** only the `SheetContext` shape above. If the package can be turned into that, the Editor will consume it.


## Milestone 1: sketching on a PDF

M1 delivers a fast, dependable sketching surface over PDF sheets and nothing else. No snapping, no ghost, no prediction. Each requirement below has an ID so tasks and tests can cite it.

| ID | Requirement | Verified by |
|---|---|---|
| M1-01 | With no file open, show the empty state with a drop zone and a Choose file button. | Screenshot test of the empty state |
| M1-02 | Dropping or choosing a PDF opens it. A non-PDF or unreadable file shows an inline error and keeps the empty state. | E2E with a good and a corrupt fixture |
| M1-03 | Every page becomes a sheet on one board, laid out in a grid, each with its name above it. | E2E counts sheets and checks labels on the 6-page fixture |
| M1-04 | Pan with the Pan tool, space-drag, two-finger scroll. Zoom with pinch and Ctrl-scroll, centered on the pointer. | E2E checks camera state after scripted input |
| M1-05 | Sheets stay sharp when zoomed: pages re-render at the new resolution after zoom settles. | Screenshot comparison at 50% and 400% |
| M1-06 | The brush draws ink that follows the pointer, with size and smoothing from the left sidebar and color from the tool capsule. Pressure varies width when the device reports it. | Stroke replay plus screenshot |
| M1-07 | A stroke belongs to the sheet it started on and is stored in that sheet's coordinates. Ink outside any sheet is discarded. | Core unit test and E2E reading stored points |
| M1-08 | The eraser removes whole strokes it touches. | E2E replay of an erase path |
| M1-09 | Undo and redo cover strokes and erasures, from the top bar and Ctrl-Z, Ctrl-Shift-Z. | E2E |
| M1-10 | Work autosaves to the sidecar file and is restored when the same PDF is reopened. | E2E reload test |
| M1-11 | The left sidebar shows the active tool's options. Sections collapse. Mode, Snapping and Commit controls are present but disabled, labeled as coming later. | Screenshot test |
| M1-12 | Strokes can be recorded to fixture files from a dev-only toggle. | E2E writes and re-reads a recording |

**Deliberately absent in M1:** the Reading panel, ghost geometry, snap markers, confidence chips, any model call. The right sidebar shows only the session list of strokes.

M1-12 looks out of place but matters most for later milestones. Every stroke a teammate draws while testing M1 becomes labeled training and test data for M3.


## The contextual brush

The brush behaves like live dictation: it shows a guess while the stroke is still being drawn, revises only the element in progress, and commits when the pen pauses. Speed comes from never waiting for the stroke to end, not from a fast model.

[embed]  {'id': '.10544', 'h': 'e5fde4f1', 'caption': 'prediction pipeline · two inputs, a four-step first pass, one decision', 'ref': 'node/29d2958b-2619'}
The loop inside the tinted band runs many times per stroke. A model, when present, only nudges scores from the side and can be removed without changing the flow.

**What counts as context**

| Signal | How a plain PDF yields it | What it tells the brush |
|---|---|---|
| Nearby linework | Pairs of parallel lines and thick strokes are wall candidates | Whether the stroke runs along, crosses or ends on a wall |
| Grid lines | Long dash-dot lines ending in a bubble with a letter or number | Where to snap, what to align with |
| Text labels | Text runs such as "OFFICE 201" or "STAIR 2" | Room type, which shifts what is likely there |
| Enclosing region | The closed loop of wall candidates around the stroke | Which room the stroke is in and how big that room is |
| Sheet scale | Text such as "1:100" | Real size: a 0.9 m stroke across a wall is probably a door |
| Session history | Earlier strokes and their accepted readings | Sequences: a door often follows a wall, desks repeat |
| Tool settings | The Mode control in the left sidebar | A forced reading, or a narrowed set of options |

A scanned PDF has no vectors or text. For those sheets the context is empty and the brush falls back to stroke shape alone.

**Stroke features**

- Best-fit primitive (line, polyline, arc, rectangle, closed blob) and how well it fits.
- Length and bounding box in real units when the scale is known.
- Closure, corner count, self-intersections.
- Speed and pressure profile.
- Grouping: strokes close in time and space are read together as one gesture.

**Decision vocabulary**

| Decision | Typical evidence | Command emitted |
|---|---|---|
| Wall | Straight or polyline stroke, longer than about 1 m, ending near walls or grids | `create_wall` |
| Door | Short stroke crossing a wall, or a small arc beside one | `place_door` |
| Furniture | Small closed shape or symbol inside a room | `place_instance` |
| Delete | Eraser stroke, or a scribble, over a detected item | `delete` |
| Markup | Anything else, or low confidence | none, the ink stays ink |

Markup is the safe default. A wrong element is worse than no element, so weak evidence leaves the sketch untouched.

**Engine rules**

1. Re-run on new points, at most every 50 ms. Emit the first hypothesis within 50 ms of pen-down.
2. A hypothesis carries a kind, fitted and snapped geometry, a confidence and ranked alternatives.
3. Refine from coarse to fine: linear or closed first, then the kind, then the type. Later steps narrow earlier ones and never contradict them.
4. Switch the leading kind only when a challenger leads by 0.15 for two runs in a row.
5. Commit after a pause, 400 ms by default. Until then every guess lives only in the Editor.
6. After commit the element is frozen. A late second-pass answer may add a suggestion chip and nothing more.
7. Between 0.35 and 0.6 confidence, show the top two as chips. Below 0.35, keep it as markup.

All thresholds are starting values to tune against the stroke corpus.

**Interfaces**

```ts
interface Hypothesis {
  kind: 'wall' | 'door' | 'furniture' | 'delete' | 'markup'
  geometry: Path            // fitted and snapped, sheet points
  confidence: number        // 0..1
  alternatives: { kind: Hypothesis['kind']; confidence: number }[]
  stable: boolean
}

// First pass: synchronous and pure. Same input, same output.
interface Predictor {
  update(stroke: Stroke, ctx: SheetContext, settings: BrushSettings): Hypothesis
}

// Second pass: asynchronous and optional.
interface Rescorer {
  rescore(packet: ContextPacket, candidates: Hypothesis[]): Promise<Hypothesis[]>
}
```

**Second pass (M4)**

Three adapters sit behind `Rescorer`, chosen by a setting and all optional:

- **Local:** a small model on the laptop GPU, constrained to one token per option, with the option probabilities read directly.
- **Hosted LLM:** a fast model such as Claude Haiku, given the decision vocabulary as tools.
- **Jev:** a decision model that returns typed choices with probabilities.

Each receives the same compact context packet: stroke features, the nearest context items, the room label, the scale, the last three accepted decisions and the candidate list. Tests replay recorded responses, so CI needs no network or keys.


## UI spec

The visual target is the [Enhanced Drawing Editor design canvas](https://claude.ai/artifact/HULrkckX7zjh9LHksCM63a), which has two frames: the editor mid-stroke and the empty state. Where this section and the canvas disagree, the canvas wins on looks and this section wins on behavior.

**Regions**

| Region | Contents | First appears |
|---|---|---|
| Top bar, docked | Project name, sheet count, host status, latency readout, undo, redo, zoom | M1 (host status and latency from M3) |
| Board | All sheets side by side with a name above each. The sheet being drawn on gets an accent outline. | M1 |
| Tool capsule, floating at the bottom center | Select, Brush, Eraser, Pan, ink color, Live toggle | M1 (Live toggle from M3) |
| Left sidebar, docked | Options for the active tool in collapsible sections: Stroke, Mode, Snapping, Commit | M1 (Stroke only; the rest enabled from M2 and M3) |
| Right sidebar, docked | Collapsible sections: Reading your stroke, This session | M1 (session list); Reading from M3 |
| On-sheet overlays | Ink, ghost geometry, snap markers, the confidence chip by the pen | Ink in M1, snap markers in M2, the rest in M3 |

**Look**

- Solid light gray and off-white surfaces. No gradients, no translucency.
- Base text 12 px, secondary text 11 px, numbers in a monospace face.
- One accent color for the active tool, the active sheet and the leading hypothesis. Ink is red by default.
- Buttons and rows stay 44 px tall, sized for a pen.

**States to build and screenshot-test**

1. Empty: no file, drop zone, tools disabled.
2. Loading: sheets appear as placeholders in their final positions, then fill in.
3. Loaded and idle.
4. Mid-stroke with ink only (M1).
5. Mid-stroke with ghost, snap markers and chip (M3).
6. Low confidence: two chips offered beside the stroke (M3).
7. Error: file could not be read.

States 2, 6 and 7 are not drawn on the canvas yet and need a frame each before they are built.


## Agent harness and tooling

Agents can build this hands-off only if they can answer "did it work?" by running one command. The harness is therefore built first (M0), before any feature, and every requirement in this spec maps to a test an agent can run and read.

**Repo layout**

```text
brush/
  AGENTS.md              rules, commands, definition of done (CLAUDE.md points here)
  docs/
    spec.md              this document, exported
    tasks/               one file per task: goal, requirement IDs, acceptance tests
    decisions/           short records of choices and why
  src/
    core/                types, geometry, stroke, context, predict, commands
    app/                 React UI, tldraw integration, pdf rendering, test API
  src-tauri/             shell only
  fixtures/
    pdfs/                sample sheets: vector, scanned, 1-page, 6-page, corrupt
    strokes/             recorded strokes with expected labels
    cassettes/           recorded model responses for the second pass
  tests/
    unit/                Vitest, core only
    e2e/                 Playwright, drives the app in Chromium
    eval/                prediction accuracy and latency over the corpus
  reports/               generated: screenshots, eval tables, perf numbers (not committed)
```

**Commands**

| Command | Does | Target time |
|---|---|---|
| `pnpm dev` | Runs the app in a browser tab with hot reload | instant reloads |
| `pnpm check` | Typecheck, lint, core unit tests | under 30 s |
| `pnpm e2e` | Playwright suite, saves screenshots to `reports/screens` | a few minutes |
| `pnpm eval` | Replays the stroke corpus, prints accuracy, confusion and latency tables, writes `reports/eval.json` | under 1 min |
| `pnpm verify` | All of the above plus budget gates. This is the definition of done. | under 5 min |
| `pnpm app` | Runs the Tauri shell, for humans | n/a |

**How agents drive the app**

The app runs as a plain web page and exposes a small test API on `window.__brush` in dev and test builds only. Tests and agents use it to act and to observe, so nobody has to guess from pixels.

```ts
interface BrushTestApi {
  loadPdf(url: string): Promise<void>
  sheets(): Sheet[]
  replayStroke(recording: StrokeRecording, opts?: { realtime?: boolean }): Promise<void>
  strokes(): Stroke[]
  hypotheses(): Hypothesis[]        // history for the current stroke, M3+
  commands(): Command[]             // the log, M5
  metrics(): { inkLatencyMs: number[]; firstHypothesisMs: number[]; fps: number[] }
  setSetting(key: string, value: unknown): void
}
```

- `replayStroke` feeds real pointer events to the canvas at recorded timestamps, so replays exercise the same path as a pen.
- Every E2E test saves a screenshot. Agents open those images to judge visual work against the design canvas.
- State is always readable as data (`strokes()`, `hypotheses()`), so assertions never depend on screenshots alone.

**Stroke recordings: the fuel**

A recording is the raw points with timestamps and pressure, the sheet it was drawn on, and a human label of what was meant.

```json
{
  "pdf": "office-6-sheets.pdf",
  "sheet": 1,
  "label": { "kind": "wall", "note": "closes the room on grid C" },
  "points": [{ "x": 512.4, "y": 266.1, "t": 0, "p": 0.42 }]
}
```

The app's dev toggle records them while people sketch (M1-12). Target at least 30 recordings per decision kind, from at least three different people, before tuning M3. A fifth of them are held out and never used for tuning.

**Rules for agents (the content of AGENTS.md)**

1. Work from a task file. If a task has no acceptance test, write the test first and stop for review if the requirement is unclear.
2. Done means `pnpm verify` is green. Report the eval table and any screenshots you produced.
3. Never weaken a test, a budget or a threshold to get to green. Propose the change in the task file and wait for a human.
4. `core` stays pure: no DOM, no React, no network. If a feature needs one of those, it belongs in `app`.
5. Types in `core/types` are contracts. Changing one needs a decision record and updates to every consumer in the same change.
6. No new dependency without a decision record naming the alternative considered.
7. Small commits, one requirement ID per commit message where possible.
8. Before using tldraw, pdf.js or Tauri APIs, read the docs for the pinned version. Do not code these from memory.
9. Model keys live in `.env.local` and are never committed. Tests use cassettes.

**Running several agents at once**

Lanes follow the module boundaries, so agents rarely touch the same files:

| Lane | Owns | Can start |
|---|---|---|
| Harness | Commands, CI, test API, fixtures, AGENTS.md | First, alone, until M0 is green |
| Canvas | Board, sheets, PDF rendering, tools, sidebars | After M0 |
| Stroke core | Geometry, fitting, features | After M0, in parallel with Canvas |
| Context | PDF vector and text extraction, classification, snapping | After M0, in parallel |
| Predict | Hypothesis engine, rules, stability, eval | When stroke core and context types are frozen |

A human freezes `core/types` before the parallel lanes begin. CI runs `pnpm verify` on every pull request, and nothing merges red.


## Test strategy and budgets

Three kinds of test cover the app, and `pnpm verify` fails if any budget below is missed. The numbers are proposed starting points, to be confirmed on the demo laptop.

**Kinds of test**

- **Unit (core):** fitting, snapping, feature extraction, rules and stability, each on small hand-built inputs. Fast enough to run on every save.
- **End to end (app):** Playwright loads a fixture PDF, replays recordings through real pointer events, then asserts on data from the test API and saves screenshots.
- **Eval (prediction):** replays the whole corpus through `core/predict` without a browser and reports top-1 accuracy, a confusion table per kind, how often the leading guess flipped mid-stroke, and latency percentiles.

**Budgets**

| Measure | Budget | From |
|---|---|---|
| Ink latency, pointer event to painted stroke, p95 | 16 ms | M1 |
| Pan and zoom frame rate with 6 sheets and 500 strokes | 60 fps | M1 |
| First sheet visible after opening the 6-sheet fixture | 2 s | M1 |
| Context built for one sheet, off the main thread | 1 s | M2 |
| Snap decision per pointer move | 2 ms | M2 |
| First hypothesis after pen-down, p95 | 50 ms | M3 |
| Hypothesis refresh while drawing | at least 10 per second | M3 |
| Top-1 accuracy on the held-out corpus | 85% | M3 |
| Leading guess flips per stroke, mean | under 1 | M3 |
| Wrong element committed (not markup) | under 5% of strokes | M3 |
| Second-pass answer, p95, never blocking | 1 s | M4 |

**What keeps the tests honest**

- Recordings are replayed at their original timing for latency tests and as fast as possible for accuracy tests.
- The held-out fifth of the corpus is used only by `pnpm eval`, never while tuning rules.
- Screenshot tests compare against stored baselines with a small tolerance. A changed baseline needs a human to approve it.
- Latency is measured inside the app with `performance.now()` marks around the real code path, not estimated from outside.


## Risks and open questions

The largest risk is that plain PDFs give too little context for good predictions, which is exactly why the package interface is kept ready.

**Risks**

| Risk | Effect | Mitigation |
|---|---|---|
| PDF linework is hard to classify (hatches, dimensions and furniture all look like lines) | Weak or wrong context, poor snapping | Score every context item, prefer no context to wrong context, switch to the package when it exists |
| Scanned or flattened PDFs | No vectors or text at all | Detect and fall back to shape-only prediction, say so in the UI |
| Agents use outdated tldraw, pdf.js or Tauri APIs | Slow, broken iterations | Pin versions, rule 8 in AGENTS.md, a smoke test per library in M0 |
| Too few recorded strokes | Rules tuned to one person's hand | Record from at least three people during M1 |
| Pen pressure and latency differ in the Tauri webview | Feels worse than in the browser | Test on the demo laptop early, keep the browser build as the demo fallback |
| tldraw license in a packaged build | Editor stops rendering in production mode | Get the free trial key before packaging |
| Scope for one weekend | M3 unfinished | M1 alone is a usable markup tool, and each milestone demos on its own |

**Open questions**

- Which PDFs will we demo with? Real project sheets, or the synthetic fixtures?
- Who labels the stroke recordings, and when during the weekend?
- Is the decision vocabulary right for the demo: wall, door, furniture, delete, markup?
- Should furniture be one kind, or split into desk, chair and table from the start?
- What does the `.drawing` package look like on disk, and can the Exporter produce the `SheetContext` shape directly?
- Which second-pass adapter do we try first: local, Haiku or Jev?
- Windows only, or macOS as well, for the demo build?

