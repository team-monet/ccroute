import { warn } from "../logger"

interface ResponsesRequest {
  model: string
  input: ResponsesMessage[]
  stream: true
  store: false
  parallel_tool_calls: boolean
  instructions?: string
  reasoning?: { effort: "low" | "medium" | "high" | "xhigh" }
  prompt_cache_key?: string
  service_tier?: string
  max_output_tokens?: number
  temperature?: number
  top_p?: number
}

interface ResponsesMessage {
  type: "message"
  role: "user" | "assistant"
  content: Array<{ type: "input_text" | "output_text"; text: string }>
}

function stripBillingHeaders(text: string): string {
  return text
    .split("\n")
    .filter(line => !line.trimStart().startsWith("x-anthropic-billing-header:"))
    .join("\n")
    .trim()
}

function extractSystemText(system: string | Array<{ type: string; text?: string }>): string {
  let raw: string
  if (typeof system === "string") {
    raw = system
  } else {
    raw = system
      .filter((b): b is { type: string; text: string } => b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n\n")
  }
  return stripBillingHeaders(raw)
}

function translateUserContent(
  content: string | Array<{ type: string; text?: string }>
): Array<{ type: "input_text"; text: string }> {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }]
  }
  const items: Array<{ type: "input_text"; text: string }> = []
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      items.push({ type: "input_text", text: block.text })
    } else if (block.type === "image") {
      warn("Skipping image content block in user message (not supported at v1)")
    } else if (block.type === "tool_result") {
      warn("Skipping tool_result content block in user message (not supported at v1)")
    }
  }
  return items
}

function translateAssistantContent(
  content: string | Array<{ type: string; text?: string }>
): Array<{ type: "output_text"; text: string }> {
  if (typeof content === "string") {
    return [{ type: "output_text", text: content }]
  }
  const items: Array<{ type: "output_text"; text: string }> = []
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      items.push({ type: "output_text", text: block.text })
    } else if (block.type === "tool_use") {
      warn("Skipping tool_use content block in assistant message (not supported at v1)")
    }
  }
  return items
}

export function anthropicToResponses(
  body: unknown,
  model: string,
  options?: { serviceTier?: string }
): ResponsesRequest {
  const b = body as {
    system?: string | Array<{ type: string; text?: string }>
    messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
    max_tokens?: number
    temperature?: number
    top_p?: number
    output_config?: { effort?: string }
    prompt_cache_key?: string
    metadata?: { session_id?: string }
  }

  const result: ResponsesRequest = {
    model,
    input: [],
    stream: true,
    store: false,
    parallel_tool_calls: true,
  }

  if (b.system !== undefined) {
    const instructions = extractSystemText(b.system)
    if (instructions) {
      result.instructions = instructions
    }
  }

  if (b.messages) {
    for (const msg of b.messages) {
      if (msg.role === "user") {
        const content = translateUserContent(msg.content)
        if (content.length > 0) {
          result.input.push({ type: "message", role: "user", content })
        }
      } else if (msg.role === "assistant") {
        const content = translateAssistantContent(msg.content)
        if (content.length > 0) {
          result.input.push({ type: "message", role: "assistant", content })
        }
      }
    }
  }

  if (b.max_tokens !== undefined) {
    result.max_output_tokens = b.max_tokens
  }
  if (b.temperature !== undefined) {
    result.temperature = b.temperature
  }
  if (b.top_p !== undefined) {
    result.top_p = b.top_p
  }

  if (b.output_config?.effort) {
    const effortMap: Record<string, "low" | "medium" | "high" | "xhigh"> = {
      low: "low",
      medium: "medium",
      high: "high",
      max: "xhigh",
    }
    const mapped = effortMap[b.output_config.effort]
    if (mapped) {
      result.reasoning = { effort: mapped }
    }
  }

  const cacheKey = b.prompt_cache_key ?? b.metadata?.session_id
  if (cacheKey) {
    result.prompt_cache_key = cacheKey
  }

  if (options?.serviceTier) {
    result.service_tier = options.serviceTier
  }

  return result
}

export function injectCodexHeaders(headers: Headers, accessToken: string, accountId: string): void {
  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("chatgpt-account-id", accountId)
  headers.set("content-type", "application/json")
  headers.set("accept", "text/event-stream")
  headers.set("origin", "https://chatgpt.com")
  headers.set("referer", "https://chatgpt.com/")
}
