import { describe, test, expect } from "bun:test"
import { reduceResponsesStream } from "./reducer"

async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item
  }
}

function parseSSEEvents(chunks: string[]): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = []
  for (const chunk of chunks) {
    const lines = chunk.split("\n")
    let eventType = ""
    let dataStr = ""
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7)
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6)
      }
    }
    if (eventType && dataStr) {
      events.push({ event: eventType, data: JSON.parse(dataStr) })
    }
  }
  return events
}

async function collect(
  upstream: Array<{ event: string; data: string }>
): Promise<Array<{ event: string; data: unknown }>> {
  const iter = toAsyncIterable(upstream)
  const chunks: string[] = []
  for await (const chunk of reduceResponsesStream(iter, "gpt-5.5")) {
    chunks.push(chunk)
  }
  return parseSSEEvents(chunks)
}

describe("reduceResponsesStream", () => {
  test("translates a complete response stream", async () => {
    const upstream = toAsyncIterable([
      { event: "response.created", data: JSON.stringify({ response: { id: "resp_1", model: "gpt-4.1", usage: { input_tokens: 10, output_tokens: 0 } } }) },
      { event: "response.output_text.delta", data: JSON.stringify({ delta: "Hello " }) },
      { event: "response.output_text.delta", data: JSON.stringify({ delta: "world" }) },
      { event: "response.output_text.done", data: JSON.stringify({}) },
      { event: "response.completed", data: JSON.stringify({ response: { usage: { input_tokens: 10, output_tokens: 42 } } }) },
    ])

    const chunks: string[] = []
    for await (const chunk of reduceResponsesStream(upstream, "gpt-4.1")) {
      chunks.push(chunk)
    }

    const events = parseSSEEvents(chunks)

    expect(events.length).toBe(7)
    expect(events[0].event).toBe("message_start")
    expect(events[1].event).toBe("content_block_start")
    expect(events[2].event).toBe("content_block_delta")
    expect(events[3].event).toBe("content_block_delta")
    expect(events[4].event).toBe("content_block_stop")
    expect(events[5].event).toBe("message_delta")
    expect(events[6].event).toBe("message_stop")

    const msgStart = events[0].data as {
      type: string
      message: { id: string; model: string; usage: { input_tokens: number; output_tokens: number } }
    }
    expect(msgStart.type).toBe("message_start")
    expect(msgStart.message.id).toBe("msg_resp_1")
    expect(msgStart.message.model).toBe("gpt-4.1")
    expect(msgStart.message.usage.input_tokens).toBe(10)
    expect(msgStart.message.usage.output_tokens).toBe(0)

    const delta1 = events[2].data as { type: string; delta: { type: string; text: string } }
    expect(delta1.delta.text).toBe("Hello ")

    const delta2 = events[3].data as { type: string; delta: { type: string; text: string } }
    expect(delta2.delta.text).toBe("world")

    const msgDelta = events[5].data as {
      type: string
      delta: { stop_reason: string }
      usage: { output_tokens: number }
    }
    expect(msgDelta.delta.stop_reason).toBe("end_turn")
    expect(msgDelta.usage.output_tokens).toBe(42)
  })

  test("translates a failed response stream", async () => {
    const upstream = toAsyncIterable([
      { event: "response.created", data: JSON.stringify({ response: { id: "resp_2", model: "gpt-4.1", usage: { input_tokens: 5, output_tokens: 0 } } }) },
      { event: "response.failed", data: JSON.stringify({ response: { error: { message: "upstream error" } } }) },
    ])

    const chunks: string[] = []
    for await (const chunk of reduceResponsesStream(upstream, "gpt-4.1")) {
      chunks.push(chunk)
    }

    const events = parseSSEEvents(chunks)

    expect(events.length).toBe(3)
    expect(events[0].event).toBe("message_start")
    expect(events[1].event).toBe("error")
    expect(events[2].event).toBe("message_stop")

    const errData = events[1].data as { type: string; message: string }
    expect(errData.type).toBe("api_error")
    expect(errData.message).toBe("upstream error")
  })

  describe("tool calls", () => {
    test("emits a single tool_use block with concatenated input_json_delta from a function_call stream", async () => {
      const events = await collect([
        { event: "response.created", data: JSON.stringify({ response: { id: "resp_t1", model: "gpt-5.5", usage: { input_tokens: 5, output_tokens: 0 } } }) },
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            type: "response.output_item.added",
            item: { id: "fc_001", type: "function_call", status: "in_progress", arguments: "", call_id: "call_ABC", name: "read_file" },
            output_index: 0,
          }),
        },
        { event: "response.function_call_arguments.delta", data: JSON.stringify({ type: "response.function_call_arguments.delta", delta: "{\"", item_id: "fc_001", output_index: 0 }) },
        { event: "response.function_call_arguments.delta", data: JSON.stringify({ type: "response.function_call_arguments.delta", delta: "path", item_id: "fc_001", output_index: 0 }) },
        { event: "response.function_call_arguments.delta", data: JSON.stringify({ type: "response.function_call_arguments.delta", delta: "\":\"/tmp/x.txt\"}", item_id: "fc_001", output_index: 0 }) },
        { event: "response.function_call_arguments.done", data: JSON.stringify({ type: "response.function_call_arguments.done", arguments: "{\"path\":\"/tmp/x.txt\"}", item_id: "fc_001", output_index: 0 }) },
        { event: "response.output_item.done", data: JSON.stringify({ type: "response.output_item.done", item: { id: "fc_001", type: "function_call", status: "completed", arguments: "{\"path\":\"/tmp/x.txt\"}", call_id: "call_ABC", name: "read_file" }, output_index: 0 }) },
        { event: "response.completed", data: JSON.stringify({ response: { status: "completed", usage: { input_tokens: 5, output_tokens: 12 } } }) },
      ])

      const types = events.map(e => e.event)
      expect(types).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ])

      const blockStart = events[1].data as {
        type: string
        index: number
        content_block: { type: string; id: string; name: string; input: Record<string, unknown> }
      }
      expect(blockStart.type).toBe("content_block_start")
      expect(blockStart.index).toBe(0)
      expect(blockStart.content_block.type).toBe("tool_use")
      expect(blockStart.content_block.id).toBe("call_ABC")
      expect(blockStart.content_block.name).toBe("read_file")
      expect(blockStart.content_block.input).toEqual({})

      // The first content_block_delta after block_start should be the initial
      // empty input_json_delta (per spec: "emit one content_block_delta{..., partial_json:''}")
      const firstDelta = events[2].data as { type: string; index: number; delta: { type: string; partial_json: string } }
      expect(firstDelta.type).toBe("content_block_delta")
      expect(firstDelta.index).toBe(0)
      expect(firstDelta.delta.type).toBe("input_json_delta")
      expect(firstDelta.delta.partial_json).toBe("")

      // Collect the remaining input_json_delta partial_json values and verify
      // they concatenate to the upstream arguments
      const argFragments: string[] = []
      for (let i = 3; i < events.length; i++) {
        const d = events[i].data as { delta?: { type?: string; partial_json?: string } }
        if (d.delta?.type === "input_json_delta" && typeof d.delta.partial_json === "string") {
          argFragments.push(d.delta.partial_json)
        }
      }
      const concatenated = argFragments.join("")
      expect(concatenated).toBe("{\"path\":\"/tmp/x.txt\"}")

      const msgDelta = events[events.length - 2].data as {
        delta: { stop_reason: string }
        usage: { output_tokens: number }
      }
      expect(msgDelta.delta.stop_reason).toBe("tool_use")
      expect(msgDelta.usage.output_tokens).toBe(12)
    })

    test("text-only stream produces stop_reason end_turn", async () => {
      const events = await collect([
        { event: "response.created", data: JSON.stringify({ response: { id: "resp_t2", model: "gpt-5.5", usage: { input_tokens: 1, output_tokens: 0 } } }) },
        { event: "response.output_text.delta", data: JSON.stringify({ delta: "Hello" }) },
        { event: "response.completed", data: JSON.stringify({ response: { usage: { input_tokens: 1, output_tokens: 5 } } }) },
      ])

      const types = events.map(e => e.event)
      expect(types).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ])

      const msgDelta = events[events.length - 2].data as { delta: { stop_reason: string } }
      expect(msgDelta.delta.stop_reason).toBe("end_turn")
    })

    // FIX 5: if a tool's args arrive ONLY in the .done event (no prior .delta
    // fragments), the reducer must seed the buffer from .done's arguments.
    // Otherwise flushTools emits a tool_use block with no input JSON at all.
    test("function_call_arguments.done with no prior deltas: args seeded from .done payload", async () => {
      const events = await collect([
        { event: "response.created", data: JSON.stringify({ response: { id: "resp_done_only", model: "gpt-5.5", usage: { input_tokens: 2, output_tokens: 0 } } }) },
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            type: "response.output_item.added",
            item: { id: "fc_done", type: "function_call", status: "in_progress", arguments: "", call_id: "call_done", name: "f" },
            output_index: 0,
          }),
        },
        // NO response.function_call_arguments.delta events
        { event: "response.function_call_arguments.done", data: JSON.stringify({ type: "response.function_call_arguments.done", arguments: '{"x":1}', item_id: "fc_done", output_index: 0 }) },
        { event: "response.output_item.done", data: JSON.stringify({ type: "response.output_item.done", item: { id: "fc_done", type: "function_call", status: "completed", arguments: '{"x":1}', call_id: "call_done", name: "f" }, output_index: 0 }) },
        { event: "response.completed", data: JSON.stringify({ response: { status: "completed", usage: { input_tokens: 2, output_tokens: 6 } } }) },
      ])

      const toolStart = events.find(
        (e) => e.event === "content_block_start"
          && ((e.data as Record<string, unknown>)["content_block"] as Record<string, unknown>)["type"] === "tool_use"
      )
      expect(toolStart).toBeDefined()
      const toolIndex = (toolStart!.data as Record<string, unknown>)["index"] as number

      // The tool block must contain {"x":1} — concatenated from the
      // input_json_delta partial_json fragments, not empty.
      const jsonDeltas = events.filter(
        (e) => e.event === "content_block_delta"
          && (e.data as Record<string, unknown>)["index"] === toolIndex
          && ((e.data as Record<string, unknown>)["delta"] as Record<string, unknown>)["type"] === "input_json_delta"
      )
      const concatenated = jsonDeltas
        .map((e) => ((e.data as Record<string, unknown>)["delta"] as Record<string, unknown>)["partial_json"] as string)
        .join("")
      expect(concatenated).toBe('{"x":1}')
    })

    // FIX 5 (no-double-count): if both .delta and .done arrive with args, the
    // .done must NOT append (it would double the arguments).
    test("function_call_arguments.done after deltas: does not double-count args", async () => {
      const events = await collect([
        { event: "response.created", data: JSON.stringify({ response: { id: "resp_dc", model: "gpt-5.5", usage: { input_tokens: 2, output_tokens: 0 } } }) },
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            type: "response.output_item.added",
            item: { id: "fc_dc", type: "function_call", status: "in_progress", arguments: "", call_id: "call_dc", name: "f" },
            output_index: 0,
          }),
        },
        { event: "response.function_call_arguments.delta", data: JSON.stringify({ type: "response.function_call_arguments.delta", delta: '{"x":1}', item_id: "fc_dc", output_index: 0 }) },
        { event: "response.function_call_arguments.done", data: JSON.stringify({ type: "response.function_call_arguments.done", arguments: '{"x":1}', item_id: "fc_dc", output_index: 0 }) },
        { event: "response.output_item.done", data: JSON.stringify({ type: "response.output_item.done", item: { id: "fc_dc", type: "function_call", status: "completed", arguments: '{"x":1}', call_id: "call_dc", name: "f" }, output_index: 0 }) },
        { event: "response.completed", data: JSON.stringify({ response: { status: "completed", usage: { input_tokens: 2, output_tokens: 6 } } }) },
      ])

      const toolStart = events.find(
        (e) => e.event === "content_block_start"
          && ((e.data as Record<string, unknown>)["content_block"] as Record<string, unknown>)["type"] === "tool_use"
      )
      expect(toolStart).toBeDefined()
      const toolIndex = (toolStart!.data as Record<string, unknown>)["index"] as number

      const jsonDeltas = events.filter(
        (e) => e.event === "content_block_delta"
          && (e.data as Record<string, unknown>)["index"] === toolIndex
          && ((e.data as Record<string, unknown>)["delta"] as Record<string, unknown>)["type"] === "input_json_delta"
      )
      const concatenated = jsonDeltas
        .map((e) => ((e.data as Record<string, unknown>)["delta"] as Record<string, unknown>)["partial_json"] as string)
        .join("")
      // Must be {"x":1} — NOT {"x":1}{"x":1} (the .done payload was ignored
      // because the buffer was already non-empty from the .delta).
      expect(concatenated).toBe('{"x":1}')
    })

    test("text-then-tool stream: sequential blocks at index 0 (text) and 1 (tool), no overlap, stops ascending", async () => {
      const events = await collect([
        { event: "response.created", data: JSON.stringify({ response: { id: "resp_t3", model: "gpt-5.5", usage: { input_tokens: 1, output_tokens: 0 } } }) },
        { event: "response.output_text.delta", data: JSON.stringify({ delta: "Calling" }) },
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            item: { id: "fc_010", type: "function_call", status: "in_progress", arguments: "", call_id: "call_X", name: "f" },
            output_index: 1,
          }),
        },
        { event: "response.function_call_arguments.delta", data: JSON.stringify({ delta: "{\"k\":1}", item_id: "fc_010", output_index: 1 }) },
        { event: "response.output_item.done", data: JSON.stringify({ item: { id: "fc_010", type: "function_call", status: "completed", arguments: "{\"k\":1}", call_id: "call_X", name: "f" }, output_index: 1 }) },
        { event: "response.completed", data: JSON.stringify({ response: { usage: { input_tokens: 1, output_tokens: 7 } } }) },
      ])

      // Extract block-level events
      const blockStarts = events.filter(e => e.event === "content_block_start") as Array<{ data: { index: number; content_block: { type: string } } }>
      const blockStops = events.filter(e => e.event === "content_block_stop") as Array<{ data: { index: number } }>

      expect(blockStarts).toHaveLength(2)
      expect(blockStarts[0].data.index).toBe(0)
      expect(blockStarts[0].data.content_block.type).toBe("text")
      expect(blockStarts[1].data.index).toBe(1)
      expect(blockStarts[1].data.content_block.type).toBe("tool_use")

      expect(blockStops).toHaveLength(2)
      // Stops must be in ascending index order
      expect(blockStops[0].data.index).toBeLessThan(blockStops[1].data.index)
      // And the first stop is the text block (index 0), the second is the tool block (index 1)
      expect(blockStops[0].data.index).toBe(0)
      expect(blockStops[1].data.index).toBe(1)

      // No overlap: each start must be preceded by a stop at the previous index
      for (let i = 1; i < blockStarts.length; i++) {
        expect(blockStarts[i].data.index).toBe(blockStarts[i - 1].data.index + 1)
      }

      const msgDelta = events.find(e => e.event === "message_delta")!.data as { delta: { stop_reason: string } }
      expect(msgDelta.delta.stop_reason).toBe("tool_use")
    })
  })

  // FIX 6: interleaved parallel tool calls must NOT cross-contaminate args.
  // Two function_call items with crossed arg deltas must each receive their own
  // args (concatenation per output_index), and blocks must remain sequential
  // (one open at a time, indices 0 and 1, ascending).
  test("interleaved parallel tool calls: per-output_index buffering, no cross-contamination", async () => {
    const events = await collect([
      { event: "response.created", data: JSON.stringify({ response: { id: "resp_par", model: "gpt-5.5", usage: { input_tokens: 3, output_tokens: 0 } } }) },
      {
        event: "response.output_item.added",
        data: JSON.stringify({
          item: { id: "fc_A", type: "function_call", status: "in_progress", arguments: "", call_id: "callA", name: "toolA" },
          output_index: 0,
        }),
      },
      {
        event: "response.output_item.added",
        data: JSON.stringify({
          item: { id: "fc_B", type: "function_call", status: "in_progress", arguments: "", call_id: "callB", name: "toolB" },
          output_index: 1,
        }),
      },
      { event: "response.function_call_arguments.delta", data: JSON.stringify({ delta: '{"a":1}', item_id: "fc_A", output_index: 0 }) },
      { event: "response.function_call_arguments.delta", data: JSON.stringify({ delta: '{"b":2}', item_id: "fc_B", output_index: 1 }) },
      { event: "response.output_item.done", data: JSON.stringify({ item: { id: "fc_A", type: "function_call", status: "completed", arguments: '{"a":1}', call_id: "callA", name: "toolA" }, output_index: 0 }) },
      { event: "response.output_item.done", data: JSON.stringify({ item: { id: "fc_B", type: "function_call", status: "completed", arguments: '{"b":2}', call_id: "callB", name: "toolB" }, output_index: 1 }) },
      { event: "response.completed", data: JSON.stringify({ response: { status: "completed", usage: { input_tokens: 3, output_tokens: 9 } } }) },
    ])

    const blockStarts = events.filter(e => e.event === "content_block_start") as Array<{
      data: { index: number; content_block: { type: string; id: string; name: string } }
    }>
    const blockStops = events.filter(e => e.event === "content_block_stop") as Array<{ data: { index: number } }>

    // Two tool_use blocks, sequential, indices 0 then 1.
    expect(blockStarts).toHaveLength(2)
    expect(blockStarts[0].data.index).toBe(0)
    expect(blockStarts[0].data.content_block.type).toBe("tool_use")
    expect(blockStarts[0].data.content_block.id).toBe("callA")
    expect(blockStarts[0].data.content_block.name).toBe("toolA")
    expect(blockStarts[1].data.index).toBe(1)
    expect(blockStarts[1].data.content_block.type).toBe("tool_use")
    expect(blockStarts[1].data.content_block.id).toBe("callB")
    expect(blockStarts[1].data.content_block.name).toBe("toolB")

    expect(blockStops).toHaveLength(2)
    expect(blockStops[0].data.index).toBe(0)
    expect(blockStops[1].data.index).toBe(1)

    // No overlap: the second start must be at the previous index + 1.
    for (let i = 1; i < blockStarts.length; i++) {
      expect(blockStarts[i].data.index).toBe(blockStarts[i - 1].data.index + 1)
    }

    // Collect all content_block_delta events and partition by block index to
    // verify per-tool arg concatenation. We skip the priming empty partial_json
    // that openTool emits.
    const deltas = events.filter(e => e.event === "content_block_delta") as Array<{
      data: { index: number; delta: { type: string; partial_json?: string } }
    }>

    const argsByBlock: Record<number, string> = {}
    for (const d of deltas) {
      if (d.data.delta.type !== "input_json_delta") continue
      if (typeof d.data.delta.partial_json !== "string") continue
      argsByBlock[d.data.index] = (argsByBlock[d.data.index] ?? "") + d.data.delta.partial_json
    }

    // callA's block (index 0) must contain only '{"a":1}'.
    expect(argsByBlock[0]).toBe('{"a":1}')
    // callB's block (index 1) must contain only '{"b":2}'.
    expect(argsByBlock[1]).toBe('{"b":2}')

    const msgDelta = events.find(e => e.event === "message_delta")!.data as {
      delta: { stop_reason: string }
      usage: { output_tokens: number }
    }
    expect(msgDelta.delta.stop_reason).toBe("tool_use")
    expect(msgDelta.usage.output_tokens).toBe(9)
  })

  // FIX 4: response.incomplete must yield stop_reason "max_tokens", not end_turn.
  test("response.incomplete yields stop_reason max_tokens", async () => {
    const events = await collect([
      { event: "response.created", data: JSON.stringify({ response: { id: "resp_inc", model: "gpt-4.1", usage: { input_tokens: 5, output_tokens: 0 } } }) },
      { event: "response.output_text.delta", data: JSON.stringify({ delta: "partial" }) },
      { event: "response.incomplete", data: JSON.stringify({ response: { usage: { input_tokens: 5, output_tokens: 17 } } }) },
    ])

    const msgDelta = events.find(e => e.event === "message_delta")
    expect(msgDelta).toBeDefined()
    expect((msgDelta!.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("max_tokens")
    expect((msgDelta!.data as { usage: { output_tokens: number } }).usage.output_tokens).toBe(17)
  })

  // FIX 5: a function_call arriving without a preceding response.created must
  // still produce a message_start event first, then content_block_start.
  test("function_call without response.created: message_start emitted first", async () => {
    const events = await collect([
      {
        event: "response.output_item.added",
        data: JSON.stringify({
          type: "response.output_item.added",
          item: { id: "fc_99", type: "function_call", status: "in_progress", arguments: "", call_id: "call_late", name: "f" },
          output_index: 0,
        }),
      },
      { event: "response.function_call_arguments.delta", data: JSON.stringify({ type: "response.function_call_arguments.delta", delta: "{}", item_id: "fc_99", output_index: 0 }) },
      { event: "response.output_item.done", data: JSON.stringify({ type: "response.output_item.done", item: { id: "fc_99", type: "function_call", status: "completed", arguments: "{}", call_id: "call_late", name: "f" }, output_index: 0 }) },
      { event: "response.completed", data: JSON.stringify({ response: { usage: { input_tokens: 1, output_tokens: 3 } } }) },
    ])

    expect(events[0].event).toBe("message_start")
    const msgStart = events[0].data as { message: { id: string; usage: { input_tokens: number } } }
    expect(msgStart.message.id).toMatch(/^msg_[0-9a-f]{32}$/)
    // usage zeros when no response.created was seen
    expect(msgStart.message.usage.input_tokens).toBe(0)
    expect(events[1].event).toBe("content_block_start")
  })
})
