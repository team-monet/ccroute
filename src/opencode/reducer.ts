import { AnthropicBlockEmitter } from "../sse"

/**
 * Anthropic requires strictly sequential content blocks: at most ONE block open
 * at any time, each block is content_block_start -> content_block_delta(s) ->
 * content_block_stop, fully closed before the next block opens, indices
 * increase by 1, stops occur in ascending order.
 *
 * Design: TEXT is streamed live (incrementally emitted) as the only live block.
 * TOOL CALLS are NOT streamed live — they are accumulated in a per-index buffer
 * (toolBuf) and emitted as complete, sequential content_block_start → deltas →
 * stop triples at finish_reason. This is correct because the client cannot act
 * on partial tool-argument JSON anyway, and the buffer eliminates the lossiness
 * of the previous "single open block + drop-set" design for realistic
 * interleavings (id arriving after args, args arriving in many fragments,
 * args for an index whose id/name never arrived, etc.).
 *
 * Consequence: tool_use blocks are always emitted after the text block, in
 * the order their indices were first seen (deterministic via an arrival
 * counter). Upstream interleaving of text and tools is collapsed into
 * text-before-tool. This is acceptable because tool execution is
 * order-independent and partial tool JSON is unusable.
 */

function mapFinishReason(reason: string): "end_turn" | "max_tokens" | "tool_use" {
  if (reason === "stop") return "end_turn"
  if (reason === "length") return "max_tokens"
  if (reason === "tool_calls") return "tool_use"
  return "end_turn"
}

interface ToolBufEntry {
  order: number
  id?: string
  name?: string
  args: string[]
}

export async function* reduceOpenAIStream(
  upstream: AsyncIterable<{ data: string }>,
  originalModel: string
): AsyncGenerator<string, void, void> {
  const emitter = new AnthropicBlockEmitter(originalModel)
  let arrivalCounter = 0
  const toolBuf: Map<number, ToolBufEntry> = new Map()

  const ensureMessageStart = function* (): Generator<string, void, void> {
    yield* emitter.ensureStart()
  }

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

    const hasUsableDelta =
      delta !== undefined &&
      ((delta["role"] !== undefined && delta["role"] !== null) ||
        (delta["content"] !== undefined && delta["content"] !== null) ||
        (delta["tool_calls"] !== undefined && delta["tool_calls"] !== null) ||
        (delta["reasoning_content"] !== undefined && delta["reasoning_content"] !== null))

    if (hasUsableDelta) {
      for (const s of ensureMessageStart()) yield s
    }

    const reasoningContent = delta?.["reasoning_content"]
    const deltaContent = delta?.["content"]
    const deltaToolCalls = delta?.["tool_calls"]

    const hasNonReasoningContent =
      (deltaContent !== undefined && deltaContent !== null) ||
      (deltaToolCalls !== undefined && deltaToolCalls !== null)

    if (
      typeof reasoningContent === "string" &&
      reasoningContent !== "" &&
      !hasNonReasoningContent &&
      (finishReason === undefined || finishReason === null)
    ) {
      continue
    }

    if (typeof deltaContent === "string" && deltaContent !== "") {
      for (const s of emitter.textDelta(deltaContent)) yield s
    }

    if (Array.isArray(deltaToolCalls)) {
      for (const entry of deltaToolCalls) {
        if (typeof entry !== "object" || entry === null) continue
        const e = entry as Record<string, unknown>
        const i = e["index"]
        if (typeof i !== "number") continue
        const fn = e["function"] as Record<string, unknown> | undefined

        let buf = toolBuf.get(i)
        if (!buf) {
          buf = { order: arrivalCounter++, args: [] }
          toolBuf.set(i, buf)
        }
        const id = e["id"]
        if (typeof id === "string" && id !== "") {
          buf.id = id
        }
        const name = fn?.["name"]
        if (typeof name === "string" && name !== "") {
          buf.name = name
        }
        const args = fn?.["arguments"]
        if (typeof args === "string" && args !== "") {
          buf.args.push(args)
        }
      }
    }

    if (finishReason !== undefined && finishReason !== null && !emitter.terminalEmitted) {
      const usage = parsed["usage"] as Record<string, unknown> | undefined
      const completionTokens = usage?.["completion_tokens"]
      const outputTokens = typeof completionTokens === "number" ? completionTokens : 0

      for (const s of emitter.closeCurrent()) yield s

      const sortedTools = Array.from(toolBuf.entries()).sort(
        (a, b) => a[1].order - b[1].order
      )
      for (const [, entry] of sortedTools) {
        if (
          typeof entry.id !== "string" ||
          entry.id === "" ||
          typeof entry.name !== "string" ||
          entry.name === ""
        ) {
          console.warn(
            "[reducer] skipping tool index with missing id or name:",
            { hasId: typeof entry.id === "string" && entry.id !== "", hasName: typeof entry.name === "string" && entry.name !== "" }
          )
          continue
        }
        for (const s of emitter.openTool(entry.id, entry.name)) yield s
        for (const fragment of entry.args) {
          if (typeof fragment !== "string" || fragment === "") continue
          for (const s of emitter.toolArgsDelta(fragment)) yield s
        }
        for (const s of emitter.closeCurrent()) yield s
      }

      for (const s of emitter.finish(mapFinishReason(finishReason as string), outputTokens)) yield s
    }
  }

  // Truncated stream: upstream ended without a finish_reason. Flush anyway so
  // the Anthropic stream is complete and lossless, with stop_reason tool_use
  // if a tool call was buffered, end_turn otherwise.
  if (!emitter.terminalEmitted) {
    for (const s of emitter.closeCurrent()) yield s

    const sortedTools = Array.from(toolBuf.entries()).sort(
      (a, b) => a[1].order - b[1].order
    )
    for (const [, entry] of sortedTools) {
      if (
        typeof entry.id !== "string" ||
        entry.id === "" ||
        typeof entry.name !== "string" ||
        entry.name === ""
      ) {
        console.warn(
          "[reducer] skipping tool index with missing id or name:",
          { hasId: typeof entry.id === "string" && entry.id !== "", hasName: typeof entry.name === "string" && entry.name !== "" }
        )
        continue
      }
      for (const s of emitter.openTool(entry.id, entry.name)) yield s
      for (const fragment of entry.args) {
        if (typeof fragment !== "string" || fragment === "") continue
        for (const s of emitter.toolArgsDelta(fragment)) yield s
      }
      for (const s of emitter.closeCurrent()) yield s
    }

    const truncReason: "end_turn" | "tool_use" = toolBuf.size > 0 ? "tool_use" : "end_turn"
    for (const s of emitter.finish(truncReason, 0)) yield s
  }
}
