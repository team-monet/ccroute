import { test, expect } from "bun:test"
import { tapResponse } from "./response-log"

function streamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++])
      } else {
        controller.close()
      }
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

test("tapResponse forwards bytes unchanged", async () => {
  const enc = new TextEncoder()
  const payloads = ["hello ", "world", "!"]
  const input = await collect(streamFromChunks(payloads.map(p => enc.encode(p))))
  const tapped = tapResponse(streamFromChunks(payloads.map(p => enc.encode(p))), { upstream: "test", upstreamModel: "m", status: 200 })
  const output = await collect(tapped)
  expect(output).toEqual(input)
})

test("tapResponse passes content_block_delta through unchanged", async () => {
  const enc = new TextEncoder()
  const payload = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n"
  const tapped = tapResponse(streamFromChunks([enc.encode(payload)]), { upstream: "test", upstreamModel: "m", status: 200 })
  const output = await collect(tapped)
  expect(new TextDecoder().decode(output)).toBe(payload)
})
