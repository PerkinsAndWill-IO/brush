# M3 — Streaming prediction

**Goal:** stroke fitting, features, rule-based hypotheses updated during the stroke, ghost preview, commit on pause.
**Exit:** top-1 accuracy and first-hypothesis latency meet the budgets on the labeled stroke corpus.
**Lanes:** Predict (`src/core/predict`, plugs into `pnpm eval` via `eval-entry.ts`, see [eval-entry.md](eval-entry.md)), Stroke core (features), Canvas (ghost, chips, Live toggle).

| ID | Requirement | Acceptance test |
|---|---|---|
| M3-01 | Stroke features: best-fit primitive and fit quality, length and bbox (metres when scale known), closure, corners, self-intersections, speed and pressure profile. | Unit tests per feature on hand-built strokes |
| M3-02 | Re-run on new points at most every 50 ms; first hypothesis within 50 ms of pen-down. | Eval `firstHypothesisP95Ms`; E2E `metrics().firstHypothesisMs` |
| M3-03 | A hypothesis carries kind, fitted and snapped geometry, confidence, ranked alternatives. | Unit test on `Predictor.update` output |
| M3-04 | Refine coarse to fine (linear/closed, then kind, then type); later steps never contradict earlier ones. | Unit test over a replayed stroke's hypothesis history |
| M3-05 | Switch the leading kind only when a challenger leads by 0.15 for two runs in a row. | Unit test of stability; eval `flipsPerStrokeMean` |
| M3-06 | Commit after a 400 ms pause; until then guesses live only in the Editor. | E2E replay with a pause |
| M3-07 | After commit the element is frozen. | Unit + E2E |
| M3-08 | 0.35 to 0.6 confidence shows the top two as chips; below 0.35 stays markup. | Unit test; screenshot (UI state 6) |
| M3-09 | Deterministic first pass: same input, same output. | Unit test replays the corpus twice and compares |
| M3-10 | Ghost geometry, snap markers and confidence chip by the pen (UI state 5). | Screenshot test |
| M3-11 | Grouping: strokes close in time and space are read together. | Unit test |

**Budgets from M3:** `firstHypothesisP95Ms` <= 50 ms (eval); `hypothesisRefreshPerSec` >= 10 (perf, in-app); `top1Accuracy` >= 0.85 on the held-out split (eval); `flipsPerStrokeMean` < 1 (eval); `wrongElementRate` < 0.05 (eval).

**Corpus rule:** held-out recordings (`split: "heldout"`) are used only by `pnpm eval`, never while tuning.
