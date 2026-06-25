function emit(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function randomHexId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b: number): string => b.toString(16).padStart(2, "0")).join("")
}

function mapFinishReason(reason: string): "end_turn" | "max_tokens" | "tool_use" {
  if (reason === "stop") return "end_turn"
  if (reason === "length") return "max_tokens"
  if (reason === "tool_calls") return "tool_use"
  return "end_turn"
}

export async function* reduceOpenAIStream(
  upstream: AsyncIterable<{ data: string }>,
  originalModel: string
): AsyncGenerator<string, void, void> {
  let started = false

  for await (const chunk of upstream) {
    if (chunk.data === "[DONE]") continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(chunk.data) as Record<string, unknown>
    } catch {
      continue
    }

    const choices = parsed["choices"]
    if (!Array.isArray(choices) || choices.length === 0) continue

    const choice = choices[0] as Record<string, unknown>
    const delta = choice["delta"] as Record<string, unknown> | undefined
    const finishReason = choice["finish_reason"]

    if (!started && delta?.["role"] === "assistant") {
      started = true
      yield emit("message_start", {
        type: "message",
        id: "msg_" + randomHexId(),
        role: "assistant",
        model: originalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      yield emit("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })
    }

    const deltaContent = delta?.["content"]
    if (typeof deltaContent === "string" && deltaContent !== "") {
      yield emit("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: deltaContent },
      })
    }

    if (finishReason !== undefined && finishReason !== null) {
      const usage = parsed["usage"] as Record<string, unknown> | undefined
      const completionTokens = usage?.["completion_tokens"]
      const outputTokens = typeof completionTokens === "number" ? completionTokens : 0

      yield emit("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      })
      yield emit("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapFinishReason(finishReason as string),
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      })
      yield emit("message_stop", {
        type: "message_stop",
      })
    }
  }
}
