import { anthropicError, redactSecrets } from "./errors"
import { info } from "./logger"
import type { CcrouteConfig, ResolvedRoute } from "./config"
import { countRequestTokens } from "./token-counter"
import { listAdvertisedModels, resolveRoute } from "./router"
import { anthropicToOpenAI } from "./opencode/translate"
import { reduceOpenAIStream } from "./opencode/reducer"
import { getApiKeys as getOpencodeKeys } from "./opencode/auth"
import { isUsageLimit, parseRetryAfterSeconds, KeyCooldown } from "./opencode/limit"
import { handleCodexMessages } from "./codex/handler"
import { sseToAnthropicStream } from "./sse-stream"
import { tapResponse } from "./response-log"

// OpenCode cooldown state — when a key hits the per-workspace usage limit it is
// parked for the upstream-advertised retry-after window. Module-level so cooldowns
// persist across requests within a server lifetime.
const opencodeCooldown = new KeyCooldown()

export function startServer(config: CcrouteConfig): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: config.port,
    hostname: "127.0.0.1",
    // Streaming passthrough: upstream SSE can idle >10s (extended thinking, large-context
    // prompt processing, gaps between events). Bun's default idleTimeout is 10s, which would
    // reap the client socket mid-stream → Claude Code "Connection closed mid-response".
    // 255 is Bun's max (0 disables); a genuinely hung connection still gets reaped.
    idleTimeout: 255,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      info("request", { method: req.method, path: url.pathname })
      if (url.pathname === "/healthz") return new Response("ok", { status: 200 })
      if (url.pathname === "/v1/messages" && req.method === "POST") return handleMessages(req, config)
      if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") return handleCountTokens(req, config)
      if (url.pathname === "/v1/models" && req.method === "GET") return handleModels(config)
      return anthropicError(404, "not_found_error", `Unknown path: ${req.method} ${url.pathname}`)
    },
  })
  info("server listening", { url: server.url.href })
  return { port: server.port ?? config.port, stop: () => server.stop() }
}

async function handleMessages(req: Request, config: CcrouteConfig): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return anthropicError(400, "invalid_request_error", "Request body must be valid JSON")
  }
  if (typeof body !== "object" || body === null) {
    return anthropicError(400, "invalid_request_error", "Request body must be a JSON object")
  }
  const b = body as Record<string, unknown>
  if (typeof b["model"] !== "string") {
    return anthropicError(400, "invalid_request_error", "Request body must include a 'model' field")
  }
  const modelId = b["model"]

  const systemBlocks: unknown[] = Array.isArray(b["system"])
    ? b["system"]
    : typeof b["system"] === "string"
      ? [b["system"]]
      : []

  const route = resolveRoute(modelId, systemBlocks, config)
  info("routed", {
    agent: route.kind === "resolved" ? route.matchedAgent : null,
    originalModel: modelId,
    kind: route.kind,
    upstream: route.kind === "resolved" ? route.route.upstream : "anthropic",
    upstreamModel: route.kind === "resolved" ? route.route.upstreamModelId : modelId,
  })
  if (route.kind === "anthropic-passthrough") {
    return handleAnthropicPassthrough(req, b, config)
  }
  if (route.kind === "anthropic-reject") {
    return anthropicError(400, "invalid_request_error", route.message)
  }
  if (route.kind === "unknown-model") {
    return anthropicError(400, "not_found_error", route.message)
  }
  if (route.kind === "not-allowed") {
    return anthropicError(403, "permission_error", route.message)
  }

  if (route.route.upstream === "opencode") {
    return await handleOpencode(b, route.route, config)
  }
  return await handleCodexMessages(req, b, route.route as { upstream: "codex"; upstreamModelId: string; endpointPath: "/backend-api/codex/responses" }, config)
}

async function handleOpencode(
  body: Record<string, unknown>,
  route: ResolvedRoute,
  config: CcrouteConfig,
): Promise<Response> {
  const keys = getOpencodeKeys()
  if (keys.length === 0) {
    return anthropicError(503, "api_error", "OpenCode API key not configured. Run: ccroute opencode auth login")
  }
  const baseUrl = config.opencode.baseUrl.replace(/\/+$/, "")
  const url = `${baseUrl}${route.endpointPath}`
  const isMessages = route.endpointPath === "/v1/messages"
  if (route.endpointPath !== "/v1/messages" && route.endpointPath !== "/v1/chat/completions") {
    return anthropicError(500, "api_error", `Unknown OpenCode endpoint: ${route.endpointPath}`)
  }
  const tried = new Set<string>()
  let lastLimitBody: string | null = null

  for (;;) {
    // Pick the first key not yet tried this request AND not currently in cooldown.
    const key = keys.find((k) => !tried.has(k) && opencodeCooldown.isAvailable(k))
    if (!key) break
    tried.add(key)

    const headers = isMessages
      ? new Headers({
          "x-api-key": key,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "accept": "text/event-stream",
        })
      : new Headers({
          "authorization": `Bearer ${key}`,
          "content-type": "application/json",
          "accept": "text/event-stream",
        })
    // /v1/messages takes the Anthropic-shaped body (model/stream overridden);
    // /v1/chat/completions takes the OpenAI-shaped translation.
    const upstreamBody = isMessages
      ? { ...body, model: route.upstreamModelId, stream: true }
      : anthropicToOpenAI(body, route.upstreamModelId)

    let upstream: Response
    try {
      upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody) })
    } catch (err) {
      return anthropicError(502, "api_error", `Cannot reach OpenCode Go: ${err}`)
    }

    if (!upstream.ok) {
      const errBody = await upstream.text()
      if (isUsageLimit(upstream.status, errBody)) {
        const retry = parseRetryAfterSeconds(upstream.headers.get("retry-after"), errBody)
        opencodeCooldown.park(key, retry)
        lastLimitBody = errBody
        info("response", { upstream: "opencode", upstreamModel: route.upstreamModelId, status: upstream.status, bytes: 0, events: 0, sawContent: false })
        continue // rotate to the next available key
      }
      // Non-limit error: surface as-is, do NOT burn the rest of the pool.
      info("response", { upstream: "opencode", upstreamModel: route.upstreamModelId, status: upstream.status, bytes: 0, events: 0, sawContent: false })
      return anthropicError(upstream.status, "api_error", `OpenCode upstream error: ${redactSecrets(errBody)}`)
    }

    if (!upstream.body) {
      info("response", { upstream: "opencode", upstreamModel: route.upstreamModelId, status: 502, bytes: 0, events: 0, sawContent: false })
      return anthropicError(502, "api_error", "OpenCode upstream returned no body")
    }

    // Success — stream back. Shape differs by endpoint.
    if (isMessages) {
      return new Response(tapResponse(upstream.body, { upstream: "opencode", upstreamModel: route.upstreamModelId, status: 200 }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
    const transformed = transformOpenAIToAnthropic(upstream.body, route.upstreamModelId)
    return new Response(tapResponse(transformed, { upstream: "opencode", upstreamModel: route.upstreamModelId, status: 200 }), {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }

  // Every key was either tried-and-limited or still cooling, and all tries hit the limit.
  const soonest = opencodeCooldown.soonestResetMs(keys)
  const waitS = soonest !== null ? Math.max(0, Math.ceil((soonest - Date.now()) / 1000)) : null
  const msg = `All OpenCode keys hit the usage limit${waitS != null ? `; soonest reset in ${waitS}s` : ""}.` + (lastLimitBody ? ` ${redactSecrets(lastLimitBody)}` : "")
  info("response", { upstream: "opencode", upstreamModel: route.upstreamModelId, status: 429, bytes: 0, events: 0, sawContent: false })
  return anthropicError(429, "api_error", msg)
}

async function forwardToAnthropic(
  req: Request,
  body: Record<string, unknown>,
  config: CcrouteConfig,
  path: string,
): Promise<Response> {
  const url = `${config.anthropic.baseUrl.replace(/\/+$/, "")}${path}`
  const headers = new Headers()
  const HOP_BY_HOP = new Set(["host", "content-length", "connection", "accept-encoding"])
  for (const [key, value] of req.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value)
  }
  // NOTE: let fetch throw on network failure — callers decide how to handle it.
  const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  const STRIP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "www-authenticate"])
  const responseHeaders = new Headers()
  for (const [key, value] of upstream.headers.entries()) {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) responseHeaders.set(key, value)
  }
  responseHeaders.set("cache-control", "no-cache")
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
}

async function handleAnthropicPassthrough(
  req: Request,
  body: Record<string, unknown>,
  config: CcrouteConfig,
): Promise<Response> {
  try {
    return await forwardToAnthropic(req, body, config, "/v1/messages")
  } catch (err) {
    return anthropicError(502, "api_error", `Cannot reach Anthropic: ${err}`)
  }
}

function transformOpenAIToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  originalModel: string,
): ReadableStream<Uint8Array> {
  return sseToAnthropicStream(
    upstream,
    (block) => {
      // Iterate ALL data: lines — a single \n\n-delimited block may carry more
      // than one (e.g. a [DONE] sentinel packed after a normal chunk, or
      // back-to-back chunks if the upstream omitted blank-line separators).
      // The first [DONE] wins and the sentinel itself is not forwarded.
      const items: { data: string }[] = []
      for (const line of block.split("\n")) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6).trim()
        if (data === "[DONE]") return { items, done: true }
        items.push({ data })
      }
      return { items, done: false }
    },
    (it) => reduceOpenAIStream(it, originalModel),
  )
}

async function handleCountTokens(req: Request, config: CcrouteConfig): Promise<Response> {
  let body: unknown
  try { body = await req.json() } catch (err) {
    return anthropicError(400, "invalid_request_error", `Bad request: ${err}`)
  }
  const b = (body && typeof body === "object") ? body as Record<string, unknown> : {}
  const model = typeof b["model"] === "string" ? b["model"] as string : ""
  const systemBlocks: unknown[] = Array.isArray(b["system"])
    ? b["system"] as unknown[]
    : typeof b["system"] === "string" ? [b["system"]] : []

  const route = resolveRoute(model, systemBlocks, config)
  if (route.kind === "anthropic-passthrough") {
    try {
      return await forwardToAnthropic(req, b, config, "/v1/messages/count_tokens")
    } catch {
      // network failure — fall through to the local estimate below
    }
  }

  try {
    const { input_tokens } = countRequestTokens(body)
    return new Response(JSON.stringify({ input_tokens }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  } catch (err) {
    return anthropicError(400, "invalid_request_error", `Bad request: ${err}`)
  }
}

async function handleModels(config: CcrouteConfig): Promise<Response> {
  const models = listAdvertisedModels(config)
  return new Response(
    JSON.stringify({
      object: "list",
      data: models.map(m => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.upstream,
        display_name: m.displayName,
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )
}
