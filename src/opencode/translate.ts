import { warn } from "../logger"

interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface OpenAITool {
  type: "function"
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string }

interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  stream: true
  max_tokens?: number
  temperature?: number
  top_p?: number
  tools?: OpenAITool[]
  tool_choice?: "auto" | "required" | "none" | { type: "function"; function: { name: string } }
}

interface AnthropicMessage {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }>
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

function generateMsgId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return "msg_" + Array.from(bytes, (b: number): string => b.toString(16).padStart(2, "0")).join("")
}

function isToolResultBlock(b: unknown): boolean {
  return typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "tool_result"
}

function isToolUseBlock(b: unknown): boolean {
  return typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "tool_use"
}

function isTextBlock(b: unknown): boolean {
  return typeof b === "object" && b !== null && (b as Record<string, unknown>)["type"] === "text"
}

export function anthropicToOpenAI(body: unknown, model: string): OpenAIRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("anthropicToOpenAI: body must be an object")
  }

  const input = body as Record<string, unknown>
  const messages: OpenAIMessage[] = []

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
        if (Array.isArray(content)) {
          const toolResultBlocks: Array<Record<string, unknown>> = []
          const textBlocks: Array<Record<string, unknown>> = []
          for (const block of content) {
            if (isToolResultBlock(block)) {
              toolResultBlocks.push(block as Record<string, unknown>)
            } else if (isTextBlock(block)) {
              textBlocks.push(block as Record<string, unknown>)
            }
          }
          for (const tr of toolResultBlocks) {
            const toolCallId = tr["tool_use_id"]
            if (typeof toolCallId !== "string" || toolCallId === "") {
              warn("anthropicToOpenAI: dropping tool_result with missing or empty tool_use_id")
              continue
            }
            const trContent = tr["content"]
            const flattened = extractTextFromBlocks(trContent)
            if (Array.isArray(trContent) && trContent.some((b): boolean => !isTextBlock(b))) {
              warn("anthropicToOpenAI: tool_result contained non-text blocks that were dropped", { toolCallId })
            }
            messages.push({
              role: "tool",
              tool_call_id: toolCallId,
              content: flattened === "" ? "(no content)" : flattened,
            })
          }
          if (textBlocks.length > 0) {
            const joinedText = textBlocks
              .map((b): string => b["text"] as string)
              .join("\n")
            messages.push({ role: "user", content: joinedText })
          }
        } else {
          messages.push({ role: "user", content: extractTextFromBlocks(content) })
        }
      } else if (role === "assistant") {
        if (Array.isArray(content) && content.some((b): boolean => isToolUseBlock(b))) {
          const textParts: string[] = []
          const toolCalls: OpenAIToolCall[] = []
          for (const block of content) {
            if (isTextBlock(block)) {
              textParts.push((block as Record<string, unknown>)["text"] as string)
            } else if (isToolUseBlock(block)) {
              const b = block as Record<string, unknown>
              const id = b["id"]
              const name = b["name"]
              if (typeof id !== "string" || id === "" || typeof name !== "string" || name === "") {
                warn("anthropicToOpenAI: dropping tool_use with missing or empty id/name", {
                  hasId: typeof id === "string" && id !== "",
                  hasName: typeof name === "string" && name !== "",
                })
                continue
              }
              const inputVal = b["input"] ?? {}
              toolCalls.push({
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(inputVal) },
              })
            }
          }
          const assistantMsg: { role: "assistant"; content: string; tool_calls?: OpenAIToolCall[] } = {
            role: "assistant",
            content: textParts.length > 0 ? textParts.join("\n") : "",
          }
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls
          }
          messages.push(assistantMsg)
        } else {
          messages.push({ role: "assistant", content: extractTextFromBlocks(content) })
        }
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

  const tools = input["tools"]
  if (Array.isArray(tools) && tools.length > 0) {
    const mapped: OpenAITool[] = []
    for (const t of tools) {
      if (typeof t !== "object" || t === null) continue
      const tool = t as Record<string, unknown>
      const name = tool["name"] as string | undefined
      if (typeof name !== "string") continue
      const fn: OpenAITool["function"] = {
        name,
        parameters: (tool["input_schema"] as Record<string, unknown>) ?? {},
      }
      if (typeof tool["description"] === "string") {
        fn.description = tool["description"] as string
      }
      mapped.push({ type: "function", function: fn })
    }
    if (mapped.length > 0) {
      result.tools = mapped
    }
  }

  const toolChoice = input["tool_choice"]
  if (toolChoice !== undefined && toolChoice !== null) {
    if (toolChoice === "auto") {
      result.tool_choice = "auto"
    } else if (toolChoice === "any") {
      result.tool_choice = "required"
    } else if (toolChoice === "none") {
      result.tool_choice = "none"
    } else if (typeof toolChoice === "object") {
      const tc = toolChoice as Record<string, unknown>
      if (tc["type"] === "auto") {
        result.tool_choice = "auto"
      } else if (tc["type"] === "any") {
        result.tool_choice = "required"
      } else if (tc["type"] === "none") {
        result.tool_choice = "none"
      } else if (tc["type"] === "tool" && typeof tc["name"] === "string") {
        result.tool_choice = {
          type: "function",
          function: { name: tc["name"] as string },
        }
      }
    }
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

  const contentBlocks: AnthropicMessage["content"] = []
  if (content) {
    contentBlocks.push({ type: "text", text: content })
  }

  const toolCalls = message?.["tool_calls"] as Array<Record<string, unknown>> | undefined
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const fn = tc["function"] as Record<string, unknown> | undefined
      const id = tc["id"] as string | undefined
      const name = (fn?.["name"] as string) ?? ""
      if (typeof id !== "string" || id === "" || name === "") {
        warn("openAIToAnthropicMessage: dropping tool_call with missing or empty id/name", {
          hasId: typeof id === "string" && id !== "",
          hasName: name !== "",
        })
        continue
      }
      const argsStr = (fn?.["arguments"] as string) ?? "{}"
      let inputObj: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(argsStr) as unknown
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          inputObj = parsed as Record<string, unknown>
        } else {
          warn("openAIToAnthropicMessage: tool_call arguments is not a JSON object", { id, name, argsStr })
        }
      } catch (e) {
        warn("openAIToAnthropicMessage: failed to parse tool_call arguments", { id, name, argsStr, error: String(e) })
      }
      contentBlocks.push({
        type: "tool_use",
        id,
        name,
        input: inputObj,
      })
    }
  }

  return {
    id: generateMsgId(),
    type: "message",
    role: "assistant",
    model: originalModel,
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (usage?.["prompt_tokens"] as number) ?? 0,
      output_tokens: (usage?.["completion_tokens"] as number) ?? 0,
    },
  }
}
