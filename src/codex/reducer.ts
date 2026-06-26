import { AnthropicBlockEmitter, formatSSE } from "../sse"

/**
 * Anthropic requires strictly sequential content blocks: at most ONE block open
 * at any time, each block is content_block_start -> content_block_delta(s) ->
 * content_block_stop, fully closed before the next block opens, indices
 * increase by 1, stops occur in ascending order.
 *
 * Design: TEXT is streamed live (incrementally emitted) as the only live block.
 * TOOL CALLS are NOT streamed live — they are accumulated in a per-output_index
 * buffer (toolBuf) and emitted as complete, sequential content_block_start →
 * deltas → stop triples at the terminal event. This eliminates the lossiness of
 * the previous "single current block + overwrite" design for realistic
 * interleavings (two function_call items with crossed arg deltas, id arriving
 * after some args, args for an index whose id/name never arrived, etc.).
 *
 * Consequence: tool_use blocks are always emitted after the text block, in the
 * order their output_index was first seen (deterministic via an arrival
 * counter). Upstream interleaving of text and tools is collapsed into
 * text-before-tool. This is acceptable because tool execution is
 * order-independent and partial tool JSON is unusable.
 *
 * The emitter's `openTool` calls `ensureStart` and `closeCurrent`, so a stream
 * that is ONLY a function_call (no response.created, no text) still emits
 * message_start before the tool block, and any open text block is closed
 * before the tool block opens.
 */

interface ToolBufEntry {
  order: number
  callId?: string
  name?: string
  args: string[]
}

export async function* reduceResponsesStream(
  upstream: AsyncIterable<{ event?: string; data: string }>,
  originalModel: string
): AsyncGenerator<string, void, void> {
  const emitter = new AnthropicBlockEmitter(originalModel)
  const toolBuf: Map<number, ToolBufEntry> = new Map()
  let arrivalCounter = 0
  let sawTool = false

  function* flushTools(): Generator<string, void, void> {
    const sorted = Array.from(toolBuf.entries()).sort((a, b) => a[1].order - b[1].order)
    for (const [, entry] of sorted) {
      if (typeof entry.callId !== "string" || entry.callId === "" ||
          typeof entry.name !== "string" || entry.name === "") {
        console.warn(
          "[reducer] skipping tool index with missing call_id or name:",
          { hasCallId: typeof entry.callId === "string" && entry.callId !== "", hasName: typeof entry.name === "string" && entry.name !== "" }
        )
        continue
      }
      yield* emitter.openTool(entry.callId, entry.name)
      for (const fragment of entry.args) {
        if (typeof fragment !== "string" || fragment === "") continue
        yield* emitter.toolArgsDelta(fragment)
      }
      yield* emitter.closeCurrent()
    }
  }

  for await (const { event, data } of upstream) {
    if (!event) continue

    switch (event) {
      case "response.created": {
        const p = JSON.parse(data) as {
          response: { id: string; model: string; usage: { input_tokens: number; output_tokens: number } | null }
        }
        for (const s of emitter.ensureStart({
          id: `msg_${p.response.id}`,
          inputTokens: p.response.usage?.input_tokens ?? 0,
        })) yield s
        break
      }

      case "response.output_item.added": {
        const p = JSON.parse(data) as {
          item: { id: string; type: string; status?: string; arguments?: string; call_id?: string; name?: string }
          output_index: number
        }
        if (p.item.type === "function_call") {
          const idx = p.output_index
          let buf = toolBuf.get(idx)
          if (!buf) {
            buf = { order: arrivalCounter++, args: [] }
            toolBuf.set(idx, buf)
          }
          if (typeof p.item.call_id === "string" && p.item.call_id !== "") {
            buf.callId = p.item.call_id
          }
          if (typeof p.item.name === "string" && p.item.name !== "") {
            buf.name = p.item.name
          }
          sawTool = true
        }
        break
      }

      case "response.function_call_arguments.delta": {
        const p = JSON.parse(data) as { delta: string; output_index: number }
        const buf = toolBuf.get(p.output_index)
        if (buf && typeof p.delta === "string" && p.delta !== "") {
          buf.args.push(p.delta)
        }
        break
      }

      case "response.function_call_arguments.done": {
        // .done carries the complete arguments string. If no .delta fragments
        // were buffered (some upstreams send only .done, no .delta), seed the
        // buffer with the complete payload so flushTools has something to emit.
        // Skip when deltas already exist to avoid double-counting.
        const p = JSON.parse(data) as { arguments?: string; output_index: number }
        const buf = toolBuf.get(p.output_index)
        if (
          buf &&
          buf.args.length === 0 &&
          typeof p.arguments === "string" &&
          p.arguments !== ""
        ) {
          buf.args.push(p.arguments)
        }
        break
      }

      case "response.output_text.delta": {
        const p = JSON.parse(data) as { delta: string }
        if (typeof p.delta === "string") {
          for (const s of emitter.textDelta(p.delta)) yield s
        }
        break
      }

      case "response.output_text.done":
        if (emitter.currentKind === "text") {
          for (const s of emitter.closeCurrent()) yield s
        }
        break

      case "response.output_item.done": {
        const p = JSON.parse(data) as {
          item: { id: string; type: string; status?: string; arguments?: string; call_id?: string; name?: string }
          output_index: number
        }
        // Tools are buffered and flushed at the terminal, not here.
        if (p.item.type === "message") {
          if (emitter.currentKind === "text") {
            for (const s of emitter.closeCurrent()) yield s
          }
        }
        break
      }

      case "response.completed": {
        const p = JSON.parse(data) as {
          response: { usage: { input_tokens: number; output_tokens: number } | null }
        }
        for (const s of emitter.closeCurrent()) yield s
        yield* flushTools()
        for (const s of emitter.finish(sawTool ? "tool_use" : "end_turn", p.response.usage?.output_tokens ?? 0)) yield s
        break
      }

      case "response.incomplete": {
        const p = JSON.parse(data) as {
          response: { usage: { input_tokens: number; output_tokens: number } | null }
        }
        for (const s of emitter.closeCurrent()) yield s
        yield* flushTools()
        for (const s of emitter.finish("max_tokens", p.response.usage?.output_tokens ?? 0)) yield s
        break
      }

      case "response.failed": {
        const p = JSON.parse(data) as {
          response?: { error?: { message?: string } }
        }
        for (const s of emitter.closeCurrent()) yield s
        yield formatSSE("error", {
          type: "api_error",
          message: p.response?.error?.message ?? "Codex upstream reported a failed response",
        })
        yield formatSSE("message_stop", { type: "message_stop" })
        emitter.markTerminal()
        break
      }

      default:
        break
    }
  }

  // Truncated stream: upstream ended without a terminal event. Close any open
  // block, flush buffered tools, and emit a complete terminal so the Anthropic
  // stream is well-formed. Fire whenever we have something to say: a started
  // emitter OR a buffered tool (whose openTool/ensureStart will emit the
  // message_start). An entirely empty stream — no started, empty toolBuf —
  // emits nothing.
  if (!emitter.terminalEmitted && (emitter.started || toolBuf.size > 0)) {
    for (const s of emitter.closeCurrent()) yield s
    yield* flushTools()
    for (const s of emitter.finish(sawTool ? "tool_use" : "end_turn", 0)) yield s
  }
}
