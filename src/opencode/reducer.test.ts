import { describe, test, expect } from "bun:test"
import { reduceOpenAIStream } from "./reducer"

function parseSSE(raw: string): { event: string; data: Record<string, unknown> } {
  const lines = raw.split("\n")
  let event = ""
  let dataStr = ""
  for (const line of lines) {
    if (line.startsWith("event: ")) event = line.slice(7)
    else if (line.startsWith("data: ")) dataStr = line.slice(6)
  }
  return { event, data: JSON.parse(dataStr) as Record<string, unknown> }
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item
}

async function collect(
  chunks: Array<{ data: string }>,
  model: string
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  for await (const sse of reduceOpenAIStream(toAsync(chunks), model)) {
    events.push(parseSSE(sse))
  }
  return events
}

function openaiChunk(delta: Record<string, unknown>, extra?: Record<string, unknown>): string {
  return JSON.stringify({ id: "chatcmpl-test", choices: [{ delta, index: 0, ...extra }] })
}

describe("reduceOpenAIStream", () => {
  test("normal conversation emits 7 events covering all 6 event types", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant", content: "" }) },
      { data: openaiChunk({ content: "Hello" }) },
      { data: openaiChunk({ content: " world" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "glm-5.2")

    expect(events.length).toBe(7)

    expect(events[0].event).toBe("message_start")
    const msgStart = events[0].data
    expect(msgStart["type"]).toBe("message")
    expect(msgStart["role"]).toBe("assistant")
    expect(msgStart["model"]).toBe("glm-5.2")
    expect(msgStart["id"]).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(msgStart["content"]).toEqual([])
    expect(msgStart["stop_reason"]).toBeNull()

    expect(events[1].event).toBe("content_block_start")
    const blockStart = events[1].data
    expect(blockStart["type"]).toBe("content_block_start")
    expect(blockStart["index"]).toBe(0)
    expect((blockStart["content_block"] as Record<string, unknown>)["type"]).toBe("text")

    expect(events[2].event).toBe("content_block_delta")
    expect((events[2].data["delta"] as Record<string, unknown>)["text"]).toBe("Hello")

    expect(events[3].event).toBe("content_block_delta")
    expect((events[3].data["delta"] as Record<string, unknown>)["text"]).toBe(" world")

    expect(events[4].event).toBe("content_block_stop")
    expect(events[4].data["index"]).toBe(0)

    expect(events[5].event).toBe("message_delta")
    const msgDelta = events[5].data["delta"] as Record<string, unknown>
    expect(msgDelta["stop_reason"]).toBe("end_turn")
    expect(msgDelta["stop_sequence"]).toBeNull()
    expect((events[5].data["usage"] as Record<string, unknown>)["output_tokens"]).toBe(5)

    expect(events[6].event).toBe("message_stop")
    expect(events[6].data["type"]).toBe("message_stop")
  })

  test("finish_reason=length maps to max_tokens", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant", content: "" }) },
      { data: openaiChunk({ content: "partial" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "length", index: 0 }],
          usage: { completion_tokens: 100 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(messageDelta).toBeDefined()
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("max_tokens")
  })

  test("finish_reason=tool_calls maps to tool_use", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant", content: "" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 20 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(messageDelta).toBeDefined()
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("tool_use")
  })

  test("single chunk with role and finish_reason emits 5 events with no text deltas", async () => {
    const chunks = [
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: { role: "assistant" }, finish_reason: "stop", index: 0 }],
          usage: { prompt_tokens: 5, completion_tokens: 0 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    expect(events.length).toBe(5)
    expect(events[0].event).toBe("message_start")
    expect(events[1].event).toBe("content_block_start")
    expect(events[2].event).toBe("content_block_stop")
    expect(events[3].event).toBe("message_delta")
    expect(events[4].event).toBe("message_stop")

    const hasTextDelta = events.some(
      (e) => e.event === "content_block_delta"
    )
    expect(hasTextDelta).toBe(false)
  })

  test("malformed chunks are skipped silently", async () => {
    const chunks = [
      { data: "not json" },
      { data: openaiChunk({ role: "assistant", content: "" }) },
      { data: JSON.stringify({ choices: [] }) },
      { data: openaiChunk({ content: "ok" }) },
      {
        data: JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { completion_tokens: 1 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")
    expect(events[0].event).toBe("message_start")
    expect(events.some((e) => e.event === "content_block_delta")).toBe(true)
    expect(events[events.length - 1].event).toBe("message_stop")
  })
})
