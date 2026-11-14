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
