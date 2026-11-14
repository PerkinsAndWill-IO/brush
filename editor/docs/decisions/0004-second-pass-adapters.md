# 0004 Second-pass adapters, probabilities and cassettes (M4)

Date: 2026-11-14 · Lane: M4 (model second pass) · Requirement IDs: M4-01 … M4-05

## Decision

1. **No new dependency.** All three adapters are plain `fetch` (`src/app/rescore/http.ts`) with a hard timeout
   that also races the fetch, so a server that ignores `AbortSignal` cannot hold a caller. Pure parts
   (packet view, prompts, parsing, fusion, policy, rule 6, cassettes, runner) live in `src/core/rescore`.
   *Alternative considered:* `@anthropic-ai/sdk`. Rejected for now: it would be a dependency only one of three
   adapters uses, the call is one fixed request, and the same code must run in the WebView, the browser and the
   Node recorder. If the hosted adapter grows (streaming, retries, batches) switch to the SDK with its own record.
2. **One packet view for everyone (M4-02).** `packetView()` rounds numbers, sorts nearest items by distance and
   drops ids, so tiny float noise does not change the request (or its cassette hash).
3. **How each adapter yields probabilities.**
   - **Local** (OpenAI-compatible / llama.cpp server): options A–E in a fixed order, `max_tokens: 1`,
     `logprobs` + `top_logprobs: 5`, optional GBNF grammar `root ::= [A-E]`. Probabilities = exp(logprob)
     of the letter tokens, variants summed, renormalised over A–E.
   - **Hosted** (Anthropic Messages API, default model `claude-haiku-5-5`, the latest Haiku): hosted models do not
     expose logprobs. Instead of one tool per kind (that gives a hard choice, not a distribution, and N sampled
     calls would cost N× latency), the model gets **one `decide` tool** whose input is a `probabilities` object
     with all five kinds (strict schema), forced with `tool_choice: {type: "any"}` (one tool, so `any` = `decide`),
     thinking disabled and `effort: "low"` for latency. Self-reported numbers are less calibrated than logprobs,
     which is why fusion weight and the ambiguity gate keep the model to a nudge. If a model rejects forced tool
     use, `hostedCodec({ toolChoice: 'auto' })` keeps the same tool and instruction.
   - **Jev**: contract **assumed** (marked in `codecs.ts`): `POST {schema:'brush.decide/v1', choices, context, prior}`
     → `{choices:[{kind, probability}]}`. Replace when Jev publishes theirs.
4. **Fusion**: weighted log-linear, `log q = (1-w) log p_first + w log p_model`, default `w = 0.5`.
   `w = 0` (or adapter `off`) returns the first pass unchanged: the model can be removed without changing the flow.
5. **Policy**: call only when the first pass is ambiguous (top < 0.6 or top-2 margin < 0.15), at pen up,
   off the critical path (`RescoreRunner.consider` returns synchronously; the commit never awaits it; 1 s timeout).
6. **Rule 6** (`resolveAnswer`): before commit and same run → apply; newer runs → drop (stale); after commit → a
   different kind with confidence ≥ 0.5 becomes a suggestion chip, never a re-decision.
7. **Cassettes**: one JSON per request, keyed by a stable hash (`hash64` of canonical JSON of adapter, model,
   body). `fixtures/cassettes/recorded/<adapter>` (real) and `fixtures/cassettes/synthetic/<adapter>`
   (`synthetic: true`, from an oracle-with-noise simulator that **knows the label**: proves plumbing, not quality).

## Security trade-off of the hosted key

A key in the WebView/browser (`VITE_ANTHROPIC_API_KEY`, sent with `anthropic-dangerous-direct-browser-access`) is
readable by anyone who can open devtools or the bundle, and any `VITE_*` value is inlined at build time. It is read
only when `import.meta.env.DEV`, and must never be in `.env.local` when running `pnpm build`.
**Production: run a small proxy** (or a Tauri command in Rust) that holds the key and forwards to
`/v1/messages`; set `hostedBaseUrl` to it and pass no key to the client.

## CSP (src-tauri/tauri.conf.json `connect-src`, not changed here)

Add `https://api.anthropic.com` (hosted; or the proxy origin instead), `http://127.0.0.1:8080` (local default),
`http://127.0.0.1:8765` (Jev default), or whatever URLs the settings point at.
