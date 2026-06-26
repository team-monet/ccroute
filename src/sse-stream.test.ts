import { describe, test, expect } from "bun:test"
import { sseToAnthropicStream } from "./sse-stream"
import { reduceOpenAIStream } from "./opencode/reducer"

// Mirror the opencode block parser used in server.ts#transformOpenAIToAnthropic.
// Iterates ALL data: lines in a \n\n-delimited block, collects them, treats
// [DONE] as the done sentinel. This is the exact code path the opencode
// upstream goes through, so a regression here is a regression in production.
function opencodeParseBlock(block: string): { items: { data: string }[]; done: boolean } {
  const items: { data: string }[] = []
  for (const line of block.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (data === "[DONE]") return { items, done: true }
    items.push({ data })
  }
  return { items, done: false }
}

function streamFromString(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(s))
      controller.close()
    },
  })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let out = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

function parseAnthropicSSE(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  // SSE messages are separated by \n\n
  for (const block of raw.split("\n\n")) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let event = ""
    let dataStr = ""
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7)
      else if (line.startsWith("data: ")) dataStr = line.slice(6)
    }
    if (event && dataStr) {
      events.push({ event, data: JSON.parse(dataStr) as Record<string, unknown> })
    }
  }
  return events
}

describe("sseToAnthropicStream", () => {
  // FIX 1: a single \n\n block that packs a data chunk AND the [DONE] sentinel
  // together must push the chunk items BEFORE honoring done. The old code
  // checked blockDone first, which caused the chunk to be dropped.
  test("block packing a chunk with [DONE]: chunk items are pushed before EOF", async () => {
    // A single SSE block: a normal data chunk followed by [DONE] in the same
    // \n\n-delimited block. The block parser returns items=[{data:...}] and
    // done=true from the same block — the pump MUST push the items first.
    const block = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"hi"},"index":0}]}',
      'data: [DONE]',
      "",
      "",
    ].join("\n")
    const upstream = streamFromString(block)

    const transformed = sseToAnthropicStream(
      upstream,
      opencodeParseBlock,
      (it) => reduceOpenAIStream(it, "test-model"),
    )
    const out = await readAll(transformed)
    const events = parseAnthropicSSE(out)

    // We must see a content_block_delta with text "hi" — the chunk that used
    // to be dropped because the [DONE] sentinel short-circuited the loop.
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta"
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "text_delta"
    )
    expect(textDeltas).toHaveLength(1)
    expect(((textDeltas[0].data["delta"] as Record<string, unknown>)["text"])).toBe("hi")

    // And the stream must terminate cleanly: message_start, content_block_start,
    // content_block_delta, content_block_stop, message_delta, message_stop.
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  test("block with only [DONE]: stream terminates, no chunks", async () => {
    // Just the sentinel — no items should be pushed before EOF.
    const block = ['data: [DONE]', "", ""].join("\n")
    const upstream = streamFromString(block)

    const transformed = sseToAnthropicStream(
      upstream,
      opencodeParseBlock,
      (it) => reduceOpenAIStream(it, "test-model"),
    )
    const out = await readAll(transformed)
    const events = parseAnthropicSSE(out)

    // message_start fires (the reducer calls ensureMessageStart), then a
    // terminal message_delta (stop_reason=end_turn) and message_stop. No
    // content_block_* events because no real delta was pushed.
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toContain("message_start")
    expect(eventTypes).toContain("message_stop")
    const hasContentBlock = events.some(
      (e) => e.event === "content_block_start" || e.event === "content_block_delta"
    )
    expect(hasContentBlock).toBe(false)
  })

  test("multiple blocks: items from each block are pushed in order, [DONE] terminates", async () => {
    // Two normal chunks in separate blocks, then a [DONE] block.
    const payload = [
      'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}',
      "",
      "",
      'data: {"choices":[{"delta":{"content":"hel"},"index":0}]}',
      "",
      "",
      'data: {"choices":[{"delta":{"content":"lo"},"index":0}]}',
      "",
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
      "",
      "",
      'data: [DONE]',
      "",
      "",
    ].join("\n")
    const upstream = streamFromString(payload)

    const transformed = sseToAnthropicStream(
      upstream,
      opencodeParseBlock,
      (it) => reduceOpenAIStream(it, "test-model"),
    )
    const out = await readAll(transformed)
    const events = parseAnthropicSSE(out)

    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta"
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "text_delta"
    )
    expect(textDeltas).toHaveLength(2)
    expect(((textDeltas[0].data["delta"] as Record<string, unknown>)["text"])).toBe("hel")
    expect(((textDeltas[1].data["delta"] as Record<string, unknown>)["text"])).toBe("lo")

    // Stream must terminate with stop_reason end_turn and a single message_stop.
    const messageStops = events.filter((e) => e.event === "message_stop")
    expect(messageStops).toHaveLength(1)
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("end_turn")
  })
})
