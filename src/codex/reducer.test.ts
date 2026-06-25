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
})
