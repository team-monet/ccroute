import { info } from "./logger"

export interface ResponseMeta {
  upstream: string
  upstreamModel: string
  status: number
}

// Transparent tap over the client-facing SSE stream: forwards every byte
// unchanged and logs one "response" outcome line when the stream completes.
// Pairs with the upstream "routed" line and records whether the upstream
// actually produced content (sawContent = any "content_block_delta" event seen).
export function tapResponse(
  stream: ReadableStream<Uint8Array>,
  meta: ResponseMeta
): ReadableStream<Uint8Array> {
  let bytes = 0
  let events = 0
  let sawContent = false
  const decoder = new TextDecoder()
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      const text = decoder.decode(chunk, { stream: true })
      for (const line of text.split("\n")) {
        if (line.startsWith("event: content_block_delta")) events++
      }
      if (text.includes("content_block_delta")) sawContent = true
      controller.enqueue(chunk)
    },
    flush() {
      info("response", {
        upstream: meta.upstream,
        upstreamModel: meta.upstreamModel,
        status: meta.status,
        bytes,
        events,
        sawContent,
      })
    },
  })
  return stream.pipeThrough(tap)
}
