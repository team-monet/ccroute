import { anthropicError, anthropicStreamError } from "./errors"
import { info } from "./logger"
import type { CcrouteConfig, ResolvedRoute } from "./config"
import { countRequestTokens } from "./token-counter"
import { listAdvertisedModels, resolveRoute } from "./router"
import { anthropicToOpenAI } from "./opencode/translate"
import { reduceOpenAIStream } from "./opencode/reducer"
import { hasApiKey as hasOpencodeKey, getApiKey as getOpencodeKey } from "./opencode/auth"
import { handleCodexMessages } from "./codex/handler"

export function startServer(config: CcrouteConfig): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: config.port,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      info("request", { method: req.method, path: url.pathname })
      if (url.pathname === "/healthz") return new Response("ok", { status: 200 })
      if (url.pathname === "/v1/messages" && req.method === "POST") return handleMessages(req, config)
      if (url.pathname === "/v1/messages/count_tokens" && req.method === "POST") return handleCountTokens(req)
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
  if (!hasOpencodeKey()) {
    return anthropicError(503, "api_error", "OpenCode API key not configured. Run: ccroute opencode auth login")
  }
  const apiKey = getOpencodeKey()!

  if (route.endpointPath === "/v1/messages") {
    const baseUrl = config.opencode.baseUrl.replace(/\/+$/, "")
    const url = `${baseUrl}${route.endpointPath}`
    const headers = new Headers({
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "accept": "text/event-stream",
    })
    const upstreamBody = { ...body, model: route.upstreamModelId, stream: true }
    let upstream: Response
    try {
      upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody) })
    } catch (err) {
      return anthropicError(502, "api_error", `Cannot reach OpenCode Go: ${err}`)
    }
    if (!upstream.ok) {
      const errBody = await upstream.text()
      return anthropicError(upstream.status, "api_error", `OpenCode upstream error: ${errBody}`)
    }
    if (!upstream.body) {
      return anthropicError(502, "api_error", "OpenCode upstream returned no body")
    }
    return new Response(upstream.body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }

  if (route.endpointPath === "/v1/chat/completions") {
    const upstreamBody = anthropicToOpenAI(body, route.upstreamModelId)
    const baseUrl = config.opencode.baseUrl.replace(/\/+$/, "")
    const url = `${baseUrl}${route.endpointPath}`
    const headers = new Headers({
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
      "accept": "text/event-stream",
    })
    let upstream: Response
    try {
      upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody) })
    } catch (err) {
      return anthropicError(502, "api_error", `Cannot reach OpenCode Go: ${err}`)
    }
    if (!upstream.ok) {
      const errBody = await upstream.text()
      return anthropicError(upstream.status, "api_error", `OpenCode upstream error: ${errBody}`)
    }
    if (!upstream.body) {
      return anthropicError(502, "api_error", "OpenCode upstream returned no body")
    }
    const transformed = transformOpenAIToAnthropic(upstream.body, route.upstreamModelId)
    return new Response(transformed, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }

  return anthropicError(500, "api_error", `Unknown endpoint: ${route.endpointPath}`)
}

function transformOpenAIToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  originalModel: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      const decoder = new TextDecoder()
      const queue: Array<{ data: string }> = []
      let resolveNext: (() => void) | null = null
      let done = false

      const push = (item: { data: string } | null) => {
        if (item) queue.push(item)
        else done = true
        if (resolveNext) {
          resolveNext()
          resolveNext = null
        }
      }

      const iterable: AsyncIterable<{ data: string }> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (queue.length > 0) return { value: queue.shift()!, done: false }
              if (done) return { value: undefined, done: true }
              await new Promise<void>(r => { resolveNext = r })
              if (queue.length > 0) return { value: queue.shift()!, done: false }
              return { value: undefined, done: true }
            },
          }
        },
      }

      ;(async () => {
        let buffer = ""
        try {
          while (true) {
            const { done: rd, value } = await reader.read()
            if (rd) { push(null); break }
            buffer += decoder.decode(value, { stream: true })
            const events = buffer.split("\n\n")
            buffer = events.pop() ?? ""
            for (const evt of events) {
              const lines = evt.split("\n")
              for (const line of lines) {
                if (!line.startsWith("data: ")) continue
                const data = line.slice(6).trim()
                if (data === "[DONE]") { push(null); return }
                push({ data })
              }
            }
          }
        } catch {
          push(null)
        }
      })()

      try {
        for await (const sseLine of reduceOpenAIStream(iterable, originalModel)) {
          controller.enqueue(encoder.encode(sseLine))
        }
        controller.close()
      } catch (err) {
        controller.enqueue(encoder.encode(anthropicStreamError(`Stream error: ${err}`)))
        controller.close()
      } finally {
        reader.cancel().catch(() => {})
      }
    },
  })
}

async function handleCountTokens(req: Request): Promise<Response> {
  try {
    const body = await req.json() as unknown
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
