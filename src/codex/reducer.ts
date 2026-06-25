function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function* reduceResponsesStream(
  upstream: AsyncIterable<{ event?: string; data: string }>,
  originalModel: string
): AsyncGenerator<string, void, void> {
  let contentBlockStarted = false
  let contentBlockStopped = false

  for await (const { event, data } of upstream) {
    if (!event) continue

    switch (event) {
      case "response.created": {
        const p = JSON.parse(data) as {
          response: { id: string; model: string; usage: { input_tokens: number; output_tokens: number } | null }
        }
        yield formatSSE("message_start", {
          type: "message_start",
          message: {
            id: `msg_${p.response.id}`,
            type: "message",
            role: "assistant",
            model: originalModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: p.response.usage?.input_tokens ?? 0, output_tokens: 0 },
          },
        })
        break
      }

      case "response.output_text.delta": {
        const p = JSON.parse(data) as { delta: string }
        if (!contentBlockStarted) {
          yield formatSSE("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })
          contentBlockStarted = true
        }
        yield formatSSE("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: p.delta },
        })
        break
      }

      case "response.output_text.done":
        break

      case "response.completed":
      case "response.incomplete": {
        const p = JSON.parse(data) as {
          response: { usage: { input_tokens: number; output_tokens: number } | null }
        }
        if (contentBlockStarted && !contentBlockStopped) {
          yield formatSSE("content_block_stop", {
            type: "content_block_stop",
            index: 0,
          })
          contentBlockStopped = true
        }
        yield formatSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: p.response.usage?.output_tokens ?? 0 },
        })
        yield formatSSE("message_stop", {
          type: "message_stop",
        })
        break
      }

      case "response.failed": {
        const p = JSON.parse(data) as {
          response: { error: { message: string } }
        }
        yield formatSSE("error", {
          type: "api_error",
          message: p.response.error.message,
        })
        yield formatSSE("message_stop", {
          type: "message_stop",
        })
        break
      }

      default:
        break
    }
  }
}
