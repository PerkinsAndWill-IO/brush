/**
 * Vercel Function: server-side proxy for the hosted second pass (M4).
 *
 * The browser posts Anthropic Messages requests to /api/ai-gateway/v1/messages
 * (rewritten here by vercel.json); this function forwards them to Vercel AI Gateway
 * and adds credentials, so no key ever reaches the bundle.
 *
 * Credentials, first found wins:
 *   - VERCEL_OIDC_TOKEN (automatic on Vercel deployments in the gateway's team)
 *   - VERCEL_AI_GATEWAY_API_KEY / AI_GATEWAY_API_KEY (project env var)
 *
 * It is deliberately narrow so a deployed preview is not an open relay for credits:
 * POST only, the Messages endpoint only, an allow-list of models, a max_tokens cap
 * and a body size cap. Keep Vercel Deployment Protection on for previews.
 */

const GATEWAY = 'https://ai-gateway.vercel.sh/v1/messages'
const ALLOWED_MODELS = new Set(['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-4.5'])
const MAX_TOKENS = 512
const MAX_BODY_BYTES = 64 * 1024

function json(status: number, error: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: error } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export async function POST(request: Request): Promise<Response> {
  const token = process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL_AI_GATEWAY_API_KEY || process.env.AI_GATEWAY_API_KEY
  if (!token) return json(500, 'AI Gateway credentials are not configured')

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return json(413, 'request too large')

  let body: { model?: unknown; max_tokens?: unknown; stream?: unknown }
  try {
    body = JSON.parse(raw) as typeof body
  } catch {
    return json(400, 'invalid JSON')
  }
  if (typeof body.model !== 'string' || !ALLOWED_MODELS.has(body.model)) return json(400, 'model not allowed')
  if (typeof body.max_tokens !== 'number' || body.max_tokens > MAX_TOKENS) return json(400, `max_tokens must be <= ${MAX_TOKENS}`)
  if (body.stream) return json(400, 'streaming is not supported by this proxy')

  const upstream = await fetch(GATEWAY, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': request.headers.get('anthropic-version') ?? '2023-06-01',
      authorization: `Bearer ${token}`,
    },
    body: raw,
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  })
}
