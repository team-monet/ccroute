import type { CcrouteConfig } from "../config"
import { anthropicError, redactSecrets } from "../errors"
import { anthropicToResponses, injectCodexHeaders } from "./translate"
import { reduceResponsesStream } from "./reducer"
import { getValidToken, refreshAccessToken, saveTokens } from "./auth"
import { info, warn } from "../logger"
import { sseToAnthropicStream } from "../sse-stream"
import { tapResponse } from "../response-log"

export async function handleCodexMessages(
  _req: Request,
  body: Record<string, unknown>,
  route: { upstream: "codex"; upstreamModelId: string; endpointPath: "/backend-api/codex/responses" },
  config: CcrouteConfig
): Promise<Response> {
  let tokens
  try {
    tokens = await getValidToken()
  } catch (err) {
    return anthropicError(503, "authentication_error", `Codex auth failed: ${err}. Run: ccroute codex auth login`)
  }

  const upstreamBody = anthropicToResponses(body, route.upstreamModelId, {
    serviceTier: config.codex.serviceTier !== "default" ? config.codex.serviceTier : undefined,
  })
  const url = `${config.codex.baseUrl.replace(/\/+$/, "")}/backend-api/codex/responses`
  const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" })
  injectCodexHeaders(headers, tokens.accessToken, tokens.chatgptAccountId)

  let upstream = await fetchCodex(url, headers, upstreamBody)
  if (upstream.status === 401) {
    warn("Codex returned 401, force-refreshing token")
    try {
      const newTokens = await refreshAccessToken(tokens.refreshToken)
      saveTokens(newTokens)
      injectCodexHeaders(headers, newTokens.accessToken, newTokens.chatgptAccountId)
      upstream = await fetchCodex(url, headers, upstreamBody)
    } catch (err) {
      info("response", { upstream: "codex", upstreamModel: route.upstreamModelId, status: 401, bytes: 0, events: 0, sawContent: false })
      return anthropicError(401, "authentication_error", `Codex session expired and refresh failed: ${err}`)
    }
  }
  if (!upstream.ok) {
    info("response", { upstream: "codex", upstreamModel: route.upstreamModelId, status: upstream.status, bytes: 0, events: 0, sawContent: false })
    const errBody = await upstream.text()
    return anthropicError(upstream.status, "api_error", `Codex upstream error: ${redactSecrets(errBody)}`)
  }
  if (!upstream.body) {
    info("response", { upstream: "codex", upstreamModel: route.upstreamModelId, status: 502, bytes: 0, events: 0, sawContent: false })
    return anthropicError(502, "api_error", "Codex upstream returned no body")
  }

  const transformed = transformResponsesToAnthropic(upstream.body, route.upstreamModelId)
  const tapped = tapResponse(transformed, {
    upstream: "codex",
    upstreamModel: route.upstreamModelId,
    status: 200,
  })
  return new Response(tapped, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

async function fetchCodex(url: string, headers: Headers, body: unknown): Promise<Response> {
  try {
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: `fetch failed: ${err}` } }), { status: 502 })
  }
}

function transformResponsesToAnthropic(upstream: ReadableStream<Uint8Array>, originalModel: string): ReadableStream<Uint8Array> {
  return sseToAnthropicStream(
    upstream,
    (block) => {
      let eventName: string | undefined
      let data = ""
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) eventName = line.slice(7).trim()
        else if (line.startsWith("data: ")) data += line.slice(6).trim()
      }
      if (data) return { items: [{ event: eventName, data }], done: false }
      return { items: [], done: false }
    },
    (it) => reduceResponsesStream(it, originalModel),
  )
}
