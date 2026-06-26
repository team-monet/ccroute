import { warn } from "../logger"

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }

interface ResponsesRequest {
  model: string
  input: ResponsesInputItem[]
  stream: true
  store: false
  parallel_tool_calls: boolean
  instructions?: string
  reasoning?: { effort: "low" | "medium" | "high" | "xhigh" }
  prompt_cache_key?: string
  service_tier?: string
  max_output_tokens?: number
  tools?: Array<{ type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean }>
  tool_choice?: "auto" | "required" | "none" | { type: "function"; name: string }
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

function extractToolResultOutput(
  content: string | Array<{ type: string; text?: string }>
): string {
  if (typeof content === "string") {
    return content
  }
  const parts: string[] = []
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("")
}

function mapTools(
  tools: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>
): Array<{ type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean }> {
  const result: Array<{ type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean }> = []
  for (const t of tools) {
    if (typeof t.name !== "string") {
      warn("Skipping tool with non-string name (not supported at v1)")
      continue
    }
    const mapped: { type: "function"; name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean } = {
      type: "function",
      name: t.name,
      parameters: t.input_schema ?? {},
      strict: false,
    }
    if (typeof t.description === "string") {
      mapped.description = t.description
    }
    result.push(mapped)
  }
  return result
}

function mapToolChoice(
  choice: string | { type: string; name?: string }
): "auto" | "required" | "none" | { type: "function"; name: string } | undefined {
  if (typeof choice === "string") {
    if (choice === "auto") return "auto"
    if (choice === "any") return "required"
    if (choice === "none") return "none"
    return undefined
  }
  if (choice.type === "auto") return "auto"
  if (choice.type === "any") return "required"
  if (choice.type === "none") return "none"
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", name: choice.name }
  }
  return undefined
}

export function anthropicToResponses(
  body: unknown,
  model: string,
  options?: { serviceTier?: string }
): ResponsesRequest {
  const b = body as {
    system?: string | Array<{ type: string; text?: string }>
    messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }> }>
    max_tokens?: number
    output_config?: { effort?: string }
    prompt_cache_key?: string
    metadata?: { session_id?: string }
    tools?: Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>
    tool_choice?: string | { type: string; name?: string; disable_parallel_tool_use?: boolean }
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
        if (typeof msg.content === "string") {
          result.input.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: msg.content }],
          })
          continue
        }

        let pendingText = ""
        const flushText = (): void => {
          if (pendingText) {
            result.input.push({
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: pendingText }],
            })
            pendingText = ""
          }
        }

        for (const block of msg.content) {
          if (block.type === "text" && typeof block.text === "string") {
            pendingText += block.text
          } else if (block.type === "tool_result") {
            flushText()
            const toolResultBlock = block as { tool_use_id?: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean }
            const output = extractToolResultOutput(
              toolResultBlock.content ?? ""
            )
            const toolUseId = block.tool_use_id
            if (typeof toolUseId !== "string") {
              warn("Skipping tool_result block with missing tool_use_id")
              continue
            }
            const text = output || "(no content)"
            result.input.push({
              type: "function_call_output",
              call_id: toolUseId,
              output: toolResultBlock.is_error === true ? `Tool error: ${text}` : text,
            })
          } else if (block.type === "image") {
            warn("Skipping image content block in user message (not supported at v1)")
          }
        }
        flushText()
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          result.input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          })
          continue
        }

        let pendingText = ""
        const flushText = (): void => {
          if (pendingText) {
            result.input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: pendingText }],
            })
            pendingText = ""
          }
        }

        for (const block of msg.content) {
          if (block.type === "text" && typeof block.text === "string") {
            pendingText += block.text
          } else if (block.type === "tool_use") {
            flushText()
            if (typeof block.id !== "string" || typeof block.name !== "string") {
              warn("Skipping tool_use block with missing id or name")
              continue
            }
            result.input.push({
              type: "function_call",
              call_id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            })
          }
        }
        flushText()
      }
    }
  }

  // Deliberately NOT forwarded: temperature / top_p. gpt-5.5 is a reasoning model and the
  // ChatGPT-account Codex Responses endpoint rejects sampling params with HTTP 400
  // ("Unsupported parameter: temperature"). The official Codex CLI omits them too.

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

  if (b.tools && b.tools.length > 0) {
    const mapped = mapTools(b.tools)
    if (mapped.length > 0) {
      result.tools = mapped
    }
  }

  if (b.tool_choice !== undefined) {
    const mappedChoice = mapToolChoice(b.tool_choice)
    if (mappedChoice !== undefined) {
      result.tool_choice = mappedChoice
    }
    if (typeof b.tool_choice === "object" && b.tool_choice !== null && b.tool_choice.disable_parallel_tool_use === true) {
      result.parallel_tool_calls = false
    }
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
