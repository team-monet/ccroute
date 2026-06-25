import { anthropicStreamError } from "./errors"

/**
 * Shared upstream SSE → Anthropic pump.
 *
 * Both the opencode (Chat Completions) and codex (Responses) paths need the
 * same plumbing: read the upstream ReadableStream, split on `\n\n`, parse
 * each event block into items, feed them through a reducer, and encode the
 * reducer's SSE strings into the outgoing ReadableStream. The only things
 * that differ are (a) how a block is parsed into items, and (b) the reducer.
 */
export function sseToAnthropicStream<T>(
  upstream: ReadableStream<Uint8Array>,
  parseEventBlock: (block: string) => { items: T[]; done: boolean },
  reduce: (it: AsyncIterable<T>) => AsyncGenerator<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      const decoder = new TextDecoder()
      const queue: T[] = []
      let resolveNext: (() => void) | null = null
      let done = false

      const push = (item: T | null) => {
        if (item) queue.push(item)
        else done = true
        if (resolveNext) {
          resolveNext()
          resolveNext = null
        }
      }

      const iterable: AsyncIterable<T> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (queue.length > 0) return { value: queue.shift()!, done: false }
              if (done) return { value: undefined, done: true }
              await new Promise<void>(r => { resolveNext = r })
              if (queue.length > 0) return { value: queue.shift()!, done: false }
              return { value: undefined, done: true }
            },
          }
        },
      }

      ;(async () => {
        let buffer = ""
        try {
          while (true) {
            const { done: rd, value } = await reader.read()
            if (rd) { push(null); break }
            buffer += decoder.decode(value, { stream: true })
            const events = buffer.split("\n\n")
            buffer = events.pop() ?? ""
            for (const evt of events) {
              const { items, done: blockDone } = parseEventBlock(evt)
              for (const item of items) push(item)
              if (blockDone) { push(null); return }
            }
          }
        } catch {
          push(null)
        }
      })()

      try {
        for await (const sseLine of reduce(iterable)) {
          controller.enqueue(encoder.encode(sseLine))
        }
        controller.close()
      } catch (err) {
        controller.enqueue(encoder.encode(anthropicStreamError(`Stream error: ${err}`)))
        controller.close()
      } finally {
        reader.cancel().catch(() => {})
      }
    },
  })
}
