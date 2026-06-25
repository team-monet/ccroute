import { describe, test, expect, spyOn } from "bun:test"
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

function openaiChunkWithToolCalls(
  toolCalls: Array<Record<string, unknown>>,
  extra?: { role?: string; content?: string | null; reasoning_content?: string }
): string {
  const delta: Record<string, unknown> = {}
  if (extra?.role !== undefined) delta["role"] = extra.role
  if (extra?.content !== undefined) delta["content"] = extra.content
  if (extra?.reasoning_content !== undefined) delta["reasoning_content"] = extra.reasoning_content
  delta["tool_calls"] = toolCalls
  return JSON.stringify({ id: "chatcmpl-test", choices: [{ delta, index: 0 }] })
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
    expect(msgStart["type"]).toBe("message_start")
    const msg = msgStart["message"] as Record<string, unknown>
    expect(msg["type"]).toBe("message")
    expect(msg["role"]).toBe("assistant")
    expect(msg["model"]).toBe("glm-5.2")
    expect(msg["id"]).toMatch(/^msg_[0-9a-f]{32}$/)
    expect(msg["content"]).toEqual([])
    expect(msg["stop_reason"]).toBeNull()

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

  test("single chunk with role and finish_reason emits 3 events (no text block)", async () => {
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

    expect(events.length).toBe(3)
    expect(events[0].event).toBe("message_start")
    expect(events[1].event).toBe("message_delta")
    expect(events[2].event).toBe("message_stop")

    const hasTextBlock = events.some(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "text"
    )
    expect(hasTextBlock).toBe(false)
  })

  test("single tool call with no text: no text block emitted", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const textBlocks = events.filter(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "text"
    )
    expect(textBlocks).toHaveLength(0)

    const toolStarts = events.filter(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStarts).toHaveLength(1)
    expect((toolStarts[0].data["content_block"] as Record<string, unknown>)["id"]).toBe("call_1")
    expect((toolStarts[0].data["content_block"] as Record<string, unknown>)["name"]).toBe("f")

    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("tool_use")
  })

  test("text then tool: indices 0 and 1, text closes before tool", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      { data: openaiChunk({ content: "hello" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const textStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "text"
    )
    expect(textStart!.data["index"]).toBe(0)

    const toolStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStart!.data["index"]).toBe(1)

    const textStop = events.findIndex(
      (e) => e.event === "content_block_stop" && e.data["index"] === 0
    )
    const toolStop = events.findIndex(
      (e) => e.event === "content_block_stop" && e.data["index"] === 1
    )
    expect(textStop).toBeGreaterThanOrEqual(0)
    expect(toolStop).toBeGreaterThan(textStop)
  })

  test("parallel tool calls: two blocks at indices 0 and 1, each with own input_json_delta", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f1", arguments: '{"a":' } },
          { index: 1, id: "call_2", type: "function", function: { name: "f2", arguments: '{"b":' } },
        ]),
      },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, function: { arguments: '1}' } },
          { index: 1, function: { arguments: '2}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const toolStarts = events.filter(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStarts).toHaveLength(2)
    expect(toolStarts[0].data["index"]).toBe(0)
    expect(toolStarts[1].data["index"]).toBe(1)

    const jsonDeltas0 = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === 0
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    )
    // index 0's "1}" fragment is preserved: the new buffer-and-flush design
    // accumulates ALL fragments per tool index and emits the full tool block
    // at finish_reason, so no tool argument data is lost regardless of
    // upstream interleaving.
    expect(jsonDeltas0).toHaveLength(3)
    expect(((jsonDeltas0[0].data["delta"] as Record<string, unknown>)["partial_json"])).toBe("")
    expect(((jsonDeltas0[1].data["delta"] as Record<string, unknown>)["partial_json"])).toBe('{"a":')
    expect(((jsonDeltas0[2].data["delta"] as Record<string, unknown>)["partial_json"])).toBe('1}')

    const jsonDeltas1 = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === 1
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    )
    expect(jsonDeltas1).toHaveLength(3)
    expect(((jsonDeltas1[0].data["delta"] as Record<string, unknown>)["partial_json"])).toBe("")
    expect(((jsonDeltas1[1].data["delta"] as Record<string, unknown>)["partial_json"])).toBe('{"b":')
    expect(((jsonDeltas1[2].data["delta"] as Record<string, unknown>)["partial_json"])).toBe('2}')
  })

  test("argument fragments accumulate as separate input_json_deltas", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{"c' } },
        ]),
      },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, function: { arguments: 'ity":' } },
        ]),
      },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, function: { arguments: '"sf"}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const jsonDeltas = events.filter(
      (e) => e.event === "content_block_delta"
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    )
    expect(jsonDeltas).toHaveLength(4)
    const partials = jsonDeltas.map(
      (e) => (e.data["delta"] as Record<string, unknown>)["partial_json"] as string
    )
    expect(partials).toEqual(["", '{"c', 'ity":', '"sf"}'])
  })

  test("reasoning_content chunk is skipped but message_start still fires", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant", reasoning_content: "Let me think..." }) },
      { data: openaiChunk({ content: "answer" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    expect(events[0].event).toBe("message_start")
    const textStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "text"
    )
    expect(textStart).toBeDefined()
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta"
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "text_delta"
    )
    expect(textDeltas).toHaveLength(1)
    expect(((textDeltas[0].data["delta"] as Record<string, unknown>)["text"])).toBe("answer")
  })

  test("finish_reason tool_calls maps to stop_reason tool_use", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("tool_use")
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

  test("tool call then text: text streams live at index 0, tool flushed at index 1", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
        ]),
      },
      { data: openaiChunk({ content: "done" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    // In the buffer-and-flush design, tool calls are NOT streamed live.
    // Text streams live (index 0), tools are flushed at finish (index 1+).
    // The tool's arguments are preserved losslessly despite arriving before text.
    const textStart = events.findIndex(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "text"
    )
    const toolStart = events.findIndex(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    const textStop = events.findIndex(
      (e) => e.event === "content_block_stop" && e.data["index"] === 0
    )
    const toolStop = events.findIndex(
      (e) => e.event === "content_block_stop" && e.data["index"] === 1
    )

    expect(textStart).toBeGreaterThanOrEqual(0)
    expect(textStart).toBeLessThan(toolStart)
    expect(textStop).toBeGreaterThan(textStart)
    expect(toolStop).toBeGreaterThan(toolStart)

    // Tool args are preserved losslessly even though tool was buffered
    const jsonDeltas = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === 1
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    )
    const partials = jsonDeltas.map(
      (e) => (e.data["delta"] as Record<string, unknown>)["partial_json"] as string
    )
    expect(partials.join("")).toBe('{"a":1}')

    // No two blocks open at once
    let openCount = 0
    for (const e of events) {
      if (e.event === "content_block_start") openCount++
      else if (e.event === "content_block_stop") openCount--
      expect(openCount).toBeLessThanOrEqual(1)
    }
    expect(openCount).toBe(0)
  })

  test("text then tool then text: text streams as one block, tool flushed after at index 1", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      { data: openaiChunk({ content: "first" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ]),
      },
      { data: openaiChunk({ content: "after" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    // In the buffer-and-flush design:
    // - text deltas stream live into one continuous text block (index 0)
    //   because the text block stays open across the buffered tool delta
    // - the tool is flushed at finish as a separate block (index 1)
    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockStops = events.filter((e) => e.event === "content_block_stop")

    expect(blockStarts).toHaveLength(2)
    expect(blockStops).toHaveLength(2)
    expect(blockStarts[0].data["index"]).toBe(0)
    expect(blockStarts[1].data["index"]).toBe(1)
    expect(blockStops[0].data["index"]).toBe(0)
    expect(blockStops[1].data["index"]).toBe(1)

    // Both text deltas ("first" and "after") are in the single text block
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === 0
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "text_delta"
    )
    expect(textDeltas).toHaveLength(2)

    // Stops in ascending order
    const stopIndices = blockStops.map((e) => e.data["index"] as number)
    for (let i = 1; i < stopIndices.length; i++) {
      expect(stopIndices[i]).toBeGreaterThan(stopIndices[i - 1])
    }

    // No overlap
    let openCount = 0
    for (const e of events) {
      if (e.event === "content_block_start") openCount++
      else if (e.event === "content_block_stop") openCount--
      expect(openCount).toBeLessThanOrEqual(1)
    }
    expect(openCount).toBe(0)
  })

  test("content and tool_calls in same delta: sequential, no overlap", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{
            delta: {
              content: "hello ",
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
              ],
            },
            index: 0,
          }],
        }),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockStops = events.filter((e) => e.event === "content_block_stop")

    expect(blockStarts).toHaveLength(2)
    expect(blockStops).toHaveLength(2)
    expect(blockStarts[0].data["index"]).toBe(0)
    expect(blockStarts[1].data["index"]).toBe(1)

    let openCount = 0
    for (const e of events) {
      if (e.event === "content_block_start") openCount++
      else if (e.event === "content_block_stop") openCount--
      expect(openCount).toBeLessThanOrEqual(1)
    }
    expect(openCount).toBe(0)
  })

  test("empty completion (only finish_reason, no delta): message_start before message_delta/message_stop", async () => {
    const chunks = [
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { completion_tokens: 0 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    expect(events.length).toBe(3)
    expect(events[0].event).toBe("message_start")
    expect(events[1].event).toBe("message_delta")
    expect(events[2].event).toBe("message_stop")
  })

  test("initial partial_json:'' present after a tool_use start", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const toolStartIdx = events.findIndex(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStartIdx).toBeGreaterThanOrEqual(0)

    const nextDelta = events[toolStartIdx + 1]
    expect(nextDelta.event).toBe("content_block_delta")
    expect(((nextDelta.data["delta"] as Record<string, unknown>)["type"])).toBe("input_json_delta")
    expect(((nextDelta.data["delta"] as Record<string, unknown>)["partial_json"])).toBe("")

    // The real fragment follows
    const afterEmpty = events[toolStartIdx + 2]
    expect(afterEmpty.event).toBe("content_block_delta")
    expect(((afterEmpty.data["delta"] as Record<string, unknown>)["partial_json"])).toBe('{"a":1}')
  })

  // Losslessness regression tests: these scenarios are dropped by the old
  // "single current block + drop-set" design. They MUST pass with the new
  // buffer-and-flush design.

  test("3a: two tools opened together, args streamed later per index — both fully reconstruct", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_0", type: "function", function: { name: "f0", arguments: "" } },
          { index: 1, id: "call_1", type: "function", function: { name: "f1", arguments: '{"b":1}' } },
        ]),
      },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, function: { arguments: '{"a":1}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const toolStarts = events.filter(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStarts).toHaveLength(2)
    expect((toolStarts[0].data["content_block"] as Record<string, unknown>)["id"]).toBe("call_0")
    expect((toolStarts[1].data["content_block"] as Record<string, unknown>)["id"]).toBe("call_1")

    const concat = (idx: number) =>
      events.filter(
        (e) => e.event === "content_block_delta"
          && e.data["index"] === idx
          && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
      ).map((e) => (e.data["delta"] as Record<string, unknown>)["partial_json"] as string).join("")

    expect(concat(toolStarts[0].data["index"] as number)).toBe('{"a":1}')
    expect(concat(toolStarts[1].data["index"] as number)).toBe('{"b":1}')
  })

  test("3b: tool whose first fragment has args but no id/name, id/name arrive later", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, function: { arguments: '{"x' } },
        ]),
      },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_late", type: "function", function: { name: "late_fn", arguments: '":1}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const toolStarts = events.filter(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStarts).toHaveLength(1)
    const cb = toolStarts[0].data["content_block"] as Record<string, unknown>
    expect(cb["id"]).toBe("call_late")
    expect(cb["name"]).toBe("late_fn")

    const concat = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === toolStarts[0].data["index"]
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    ).map((e) => (e.data["delta"] as Record<string, unknown>)["partial_json"] as string).join("")

    expect(concat).toBe('{"x":1}')
  })

  test("3c: tool index with only args, never id/name — block skipped + warn fired", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const chunks = [
        { data: openaiChunk({ role: "assistant" }) },
        {
          data: openaiChunkWithToolCalls([
            { index: 0, function: { arguments: '{"orphan":true}' } },
          ]),
        },
        {
          data: JSON.stringify({
            id: "chatcmpl-test",
            choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
            usage: { completion_tokens: 5 },
          }),
        },
        { data: "[DONE]" },
      ]

      const events = await collect(chunks, "m")

      const toolStarts = events.filter(
        (e) => e.event === "content_block_start"
          && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
      )
      expect(toolStarts).toHaveLength(0)

      expect(warnSpy).toHaveBeenCalled()

      const messageDelta = events.find((e) => e.event === "message_delta")
      expect(messageDelta).toBeDefined()
      expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("tool_use")
    } finally {
      warnSpy.mockRestore()
    }
  })

  test("3d: tool, then content delta, then same tool index resumes — tool args intact AND text present", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_int", type: "function", function: { name: "f", arguments: '{"a":' } },
        ]),
      },
      { data: openaiChunk({ content: "thinking" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, function: { arguments: '1}' } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 5 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    // Text block present
    const textStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "text"
    )
    expect(textStart).toBeDefined()
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta"
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "text_delta"
    )
    expect(textDeltas).toHaveLength(1)
    expect(((textDeltas[0].data["delta"] as Record<string, unknown>)["text"])).toBe("thinking")

    // Tool block present with full reconstructed args
    const toolStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStart).toBeDefined()
    const toolIndex = toolStart!.data["index"]
    const concat = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === toolIndex
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    ).map((e) => (e.data["delta"] as Record<string, unknown>)["partial_json"] as string).join("")
    expect(concat).toBe('{"a":1}')

    // Sequential, no overlap
    let openCount = 0
    for (const e of events) {
      if (e.event === "content_block_start") openCount++
      else if (e.event === "content_block_stop") openCount--
      expect(openCount).toBeLessThanOrEqual(1)
    }
    expect(openCount).toBe(0)
  })

  test("truncated stream (no finish_reason): message_start … message_stop still emitted, args intact", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_t", type: "function", function: { name: "f", arguments: '{"k":42}' } },
        ]),
      },
      // No finish_reason, no [DONE] — stream just ends.
    ]

    const events = await collect(chunks, "m")

    expect(events[0].event).toBe("message_start")
    expect(events[events.length - 2].event).toBe("message_delta")
    expect(events[events.length - 1].event).toBe("message_stop")

    const messageDelta = events.find((e) => e.event === "message_delta")
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("tool_use")

    const toolStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStart).toBeDefined()
    const concat = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === toolStart!.data["index"]
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    ).map((e) => (e.data["delta"] as Record<string, unknown>)["partial_json"] as string).join("")
    expect(concat).toBe('{"k":42}')
  })

  test("concatenated partial_json equals upstream arguments for a multi-fragment tool", async () => {
    const upstreamArgs = '{"city":"San Francisco","units":"celsius","days":[1,2,3]}'
    // Split into many fragments to stress the buffer.
    const fragments = [
      '{"city"',
      ':"San ',
      'Francis',
      'co","u',
      'nits":"c',
      'elsius"',
      ',"days"',
      ':[1,2,',
      '3]}',
    ]
    expect(fragments.join("")).toBe(upstreamArgs)

    const chunks: Array<{ data: string }> = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_mf", type: "function", function: { name: "weather", arguments: fragments[0] } },
        ]),
      },
    ]
    for (let i = 1; i < fragments.length; i++) {
      chunks.push({
        data: openaiChunkWithToolCalls([
          { index: 0, function: { arguments: fragments[i] } },
        ]),
      })
    }
    chunks.push({
      data: JSON.stringify({
        id: "chatcmpl-test",
        choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
        usage: { completion_tokens: 5 },
      }),
    })
    chunks.push({ data: "[DONE]" })

    const events = await collect(chunks, "m")

    const toolStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStart).toBeDefined()
    const toolIndex = toolStart!.data["index"]

    const partials = events.filter(
      (e) => e.event === "content_block_delta"
        && e.data["index"] === toolIndex
        && ((e.data["delta"] as Record<string, unknown>)["type"]) === "input_json_delta"
    ).map((e) => (e.data["delta"] as Record<string, unknown>)["partial_json"] as string)

    // First emitted partial is the empty initial "" after content_block_start
    expect(partials[0]).toBe("")
    // Remaining partials, concatenated, must equal the upstream arguments exactly.
    expect(partials.slice(1).join("")).toBe(upstreamArgs)
  })

  // FIX 1: a chunk that carries reasoning_content + a non-null finish_reason
  // (but no content/tool_calls) must NOT be skipped — the finish handler must
  // still fire so the buffered tool call is flushed and stop_reason reflects it.
  test("reasoning_content + finish_reason: finish handler still runs, tool_use block emitted", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ]),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: { reasoning_content: "thinking" }, finish_reason: "tool_calls", index: 0 }],
          usage: { completion_tokens: 7 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const toolStarts = events.filter(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStarts).toHaveLength(1)
    expect((toolStarts[0].data["content_block"] as Record<string, unknown>)["id"]).toBe("call_1")

    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(messageDelta).toBeDefined()
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("tool_use")

    const messageStops = events.filter((e) => e.event === "message_stop")
    expect(messageStops).toHaveLength(1)
  })

  // FIX 2: a stream that buffers a tool call but ends with NO finish_reason
  // (the iterable just ends) must still emit the tool_use block AND
  // stop_reason "tool_use" (not "end_turn").
  test("truncated stream with buffered tool: stop_reason tool_use, tool block emitted", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant" }) },
      {
        data: openaiChunkWithToolCalls([
          { index: 0, id: "call_t", type: "function", function: { name: "f", arguments: '{"k":42}' } },
        ]),
      },
      // No finish_reason, no [DONE] — stream just ends.
    ]

    const events = await collect(chunks, "m")

    const toolStart = events.find(
      (e) => e.event === "content_block_start"
        && ((e.data["content_block"] as Record<string, unknown>)["type"]) === "tool_use"
    )
    expect(toolStart).toBeDefined()
    expect((toolStart!.data["content_block"] as Record<string, unknown>)["id"]).toBe("call_t")

    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(messageDelta).toBeDefined()
    expect((messageDelta!.data["delta"] as Record<string, unknown>)["stop_reason"]).toBe("tool_use")
  })

  // FIX 3: two finish_reason chunks must not double-emit the terminal.
  test("duplicate finish_reason chunk: exactly one message_stop, one message_delta", async () => {
    const chunks = [
      { data: openaiChunk({ role: "assistant", content: "hi" }) },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { completion_tokens: 2 },
        }),
      },
      {
        data: JSON.stringify({
          id: "chatcmpl-test",
          choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          usage: { completion_tokens: 2 },
        }),
      },
      { data: "[DONE]" },
    ]

    const events = await collect(chunks, "m")

    const messageDeltas = events.filter((e) => e.event === "message_delta")
    const messageStops = events.filter((e) => e.event === "message_stop")
    expect(messageDeltas).toHaveLength(1)
    expect(messageStops).toHaveLength(1)
  })
})
