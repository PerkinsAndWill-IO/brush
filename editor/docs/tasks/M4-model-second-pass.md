# M4 — Model second pass (stretch)

**Goal:** optional rescoring by a local or hosted model; confidence chips; the Reading panel.
**Exit:** accuracy on the ambiguous subset improves over M3, and no stroke ever waits on the model.
**Lanes:** Predict (`Rescorer` adapters), Canvas (Reading panel, chips).

| ID | Requirement | Acceptance test |
|---|---|---|
| M4-01 | `Rescorer` adapters behind a setting: local, hosted LLM (e.g. Claude Haiku with the decision vocabulary as tools), Jev. All optional. | Unit tests with cassettes (`fixtures/cassettes/`); no network or keys in CI |
| M4-02 | Every adapter receives the same `ContextPacket` (features, nearest items, room label, scale, last three accepted decisions, candidates). | Unit test of the packet builder |
| M4-03 | Never blocking: the first pass and commit never wait on the model. | E2E with a slow cassette: commit timing unchanged |
| M4-04 | A late answer after commit may only add a suggestion chip. | Unit + E2E |
| M4-05 | Accuracy on the ambiguous subset (`ambiguous: true` in `fixtures/strokes/index.json`) improves over M3. | Eval: ambiguous-subset top-1, M4 > M3 |
| M4-06 | Reading panel shows the evidence lines (`Hypothesis.evidence`). | Screenshot test |

**Budget from M4:** `secondPassP95Ms` <= 1000 ms, never blocking (perf).
**Keys:** `.env.local` only, never committed (rule 9).

## Notes (M4 lane, 2026-11-14)

- Built: `src/core/rescore` (packet view, codecs, fusion, policy, rule 6 `resolveAnswer`, cassettes, `RescoreRunner`,
  synthetic oracle), `src/app/rescore` (local / hosted / Jev adapters over plain fetch, `createSecondPass`,
  `rescoreSettingsFromEnv`), `scripts/record-cassettes.ts` (+ `scripts/rescore-corpus.ts`), `tests/eval/run-rescore.ts`,
  `tests/unit/rescore/**`. Decision record: `docs/decisions/0004-second-pass-adapters.md`.
- **No real cassettes yet** (no key / local runtime in the build environment). The committed set in
  `fixtures/cassettes/synthetic/` is SYNTHETIC (oracle that knows the label): eval numbers from it prove plumbing,
  not that a model helps. M4-05 stays open until `recorded/` cassettes exist and `run-rescore --source=recorded` shows
  ambiguous-subset top-1 above the first pass.
- Open for the harness lane: `scripts/verify.ts` should read `reports/rescore.json` into the `perf` source
  (`secondPassP95Ms`), and `pnpm eval` / CI could run `tsx tests/eval/run-rescore.ts`. Until real cassettes exist,
  that gate measures synthetic latencies.
- Open for the canvas lane: wire `createSecondPass` at pen up, handle `resolveAnswer` (apply / chip / drop), show
  `Hypothesis.evidence` (M4-06), E2E with a slow cassette (M4-03).
- Synthetic cassettes are keyed by request hash; when the predict lane changes features or confidences, re-run
  `pnpm exec tsx scripts/record-cassettes.ts --synthetic`.
