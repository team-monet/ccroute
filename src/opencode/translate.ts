import { warn } from "../logger"

interface OpenAIRequest {
  model: string
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  stream: true
  max_tokens?: number
  temperature?: number
  top_p?: number
}

interface AnthropicMessage {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<{ type: "text"; text: string }>
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | null
  stop_sequence: null
  usage: { input_tokens: number; output_tokens: number }
}

function extractSystemText(system: unknown): string {
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    return system
      .filter((b: unknown): boolean =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "text"
      )
      .map((b: unknown): string => (b as Record<string, unknown>)["text"] as string)
      .join("\n\n")
  }
  return ""
}

function extractTextFromBlocks(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown): boolean =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "text"
      )
      .map((b: unknown): string => (b as Record<string, unknown>)["text"] as string)
      .join("\n")
  }
  return ""
}

function hasBlockType(content: unknown, blockType: string): boolean {
  if (!Array.isArray(content)) return false
  return content.some((b: unknown): boolean =>
    typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === blockType
  )
}

function generateMsgId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return "msg_" + Array.from(bytes, (b: number): string => b.toString(16).padStart(2, "0")).join("")
}

export function anthropicToOpenAI(body: unknown, model: string): OpenAIRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("anthropicToOpenAI: body must be an object")
  }

  const input = body as Record<string, unknown>
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = []

  const systemText = extractSystemText(input["system"])
  if (systemText) {
    messages.push({ role: "system", content: systemText })
  }

  const inputMessages = input["messages"]
  if (Array.isArray(inputMessages)) {
    for (const msg of inputMessages) {
      if (typeof msg !== "object" || msg === null) continue
      const m = msg as Record<string, unknown>
      const role = m["role"] as string | undefined
      const content = m["content"]

      if (role === "user") {
        if (hasBlockType(content, "tool_result")) {
          warn("Skipping tool_result blocks in user message (not supported at v1)")
        }
        messages.push({ role: "user", content: extractTextFromBlocks(content) })
      } else if (role === "assistant") {
        if (hasBlockType(content, "tool_use")) {
          warn("Skipping tool_use blocks in assistant message (not supported at v1)")
        }
        messages.push({ role: "assistant", content: extractTextFromBlocks(content) })
      }
    }
  }

  const result: OpenAIRequest = { model, messages, stream: true }

  if (typeof input["max_tokens"] === "number") {
    result.max_tokens = input["max_tokens"] as number
  }
  if (typeof input["temperature"] === "number") {
    result.temperature = input["temperature"] as number
  }
  if (typeof input["top_p"] === "number") {
    result.top_p = input["top_p"] as number
  }

  return result
}

export function openAIToAnthropicMessage(body: unknown, originalModel: string): AnthropicMessage {
  const input = body as Record<string, unknown>
  const choices = input["choices"] as Array<Record<string, unknown>> | undefined
  const choice = choices?.[0]
  const message = choice?.["message"] as Record<string, unknown> | undefined
  const content = (message?.["content"] as string) ?? ""
  const finishReason = choice?.["finish_reason"] as string | undefined
  const usage = input["usage"] as Record<string, unknown> | undefined

  let stopReason: "end_turn" | "max_tokens" | "tool_use" | null = null
  if (finishReason === "stop") stopReason = "end_turn"
  else if (finishReason === "length") stopReason = "max_tokens"
  else if (finishReason === "tool_calls") stopReason = "tool_use"

  return {
    id: generateMsgId(),
    type: "message",
    role: "assistant",
    model: originalModel,
    content: content ? [{ type: "text", text: content }] : [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (usage?.["prompt_tokens"] as number) ?? 0,
      output_tokens: (usage?.["completion_tokens"] as number) ?? 0,
    },
  }
}
