# Second-pass cassettes (M4)

One JSON per request: `<source>/<adapter>/<requestHash>.json` (schema `brush.cassette/v1`:
adapter, model, requestHash, requestSummary, request, response, latencyMs, recordedAt, synthetic).

- `recorded/<adapter>/` real model replies. Record (needs a key or a running server, never in CI):
  `pnpm exec tsx scripts/record-cassettes.ts --adapter=hosted|local|jev` (keys/URLs in `.env.local`).
- `synthetic/<adapter>/` **SYNTHETIC** replies from a deterministic oracle-with-noise simulator that knows
  the label. They prove the plumbing (parsing, fusion, timing, rule 6), **not** model quality.
  Regenerate after first-pass changes: `pnpm exec tsx scripts/record-cassettes.ts --synthetic`.

Replay: `pnpm exec tsx tests/eval/run-rescore.ts [--adapter=hosted] [--source=recorded|synthetic]`.
Requests are keyed by hash, so a first-pass change makes cassettes miss; the eval reports misses.
