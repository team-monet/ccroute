import type { CcrouteConfig } from "../config"
import { anthropicError, anthropicStreamError } from "../errors"
import { anthropicToResponses, injectCodexHeaders } from "./translate"
import { reduceResponsesStream } from "./reducer"
import { getValidToken, refreshAccessToken, saveTokens } from "./auth"
import { warn } from "../logger"

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
      const newTokens = await refreshAccessToken(tokens.refreshToken, config.codex.baseUrl)
      saveTokens(newTokens)
      injectCodexHeaders(headers, newTokens.accessToken, newTokens.chatgptAccountId)
      upstream = await fetchCodex(url, headers, upstreamBody)
    } catch (err) {
      return anthropicError(401, "authentication_error", `Codex session expired and refresh failed: ${err}`)
    }
  }
  if (!upstream.ok) {
    const errBody = await upstream.text()
    return anthropicError(upstream.status, "api_error", `Codex upstream error: ${errBody}`)
  }
  if (!upstream.body) {
    return anthropicError(502, "api_error", "Codex upstream returned no body")
  }

  const transformed = transformResponsesToAnthropic(upstream.body, route.upstreamModelId)
  return new Response(transformed, {
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
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      const decoder = new TextDecoder()
      const queue: Array<{event?: string; data: string}> = []
      let resolveNext: (() => void) | null = null
      let done = false
      const push = (item: {event?: string; data: string} | null) => {
        if (item) queue.push(item)
        else done = true
        if (resolveNext) {
          resolveNext()
          resolveNext = null
        }
      }
      const iterable: AsyncIterable<{event?: string; data: string}> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (queue.length > 0) return { value: queue.shift()!, done: false }
              if (done) return { value: undefined, done: true }
              await new Promise<void>(r => { resolveNext = r })
              if (queue.length > 0) return { value: queue.shift()!, done: false }
              return { value: undefined, done: true }
            }
          }
        }
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
              let eventName: string | undefined
              let data = ""
              for (const line of evt.split("\n")) {
                if (line.startsWith("event: ")) eventName = line.slice(7).trim()
                else if (line.startsWith("data: ")) data += line.slice(6).trim()
              }
              if (data) push({ event: eventName, data })
            }
          }
        } catch {
          push(null)
        }
      })()
      try {
        for await (const sseLine of reduceResponsesStream(iterable, originalModel)) {
          controller.enqueue(encoder.encode(sseLine))
        }
        controller.close()
      } catch (err) {
        controller.enqueue(encoder.encode(anthropicStreamError(`Stream error: ${err}`)))
        controller.close()
      } finally {
        reader.releaseLock()
      }
    },
  })
}
