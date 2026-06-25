/**
 * Shared SSE + Anthropic envelope helpers.
 *
 * The block-sequencing state machine (text / tool_use, single-block-at-a-time,
 * ascending indices) is duplicated across the opencode (Chat Completions) and
 * codex (Responses) reducers. `AnthropicBlockEmitter` is the single source of
 * truth for message_start / content_block_* / message_delta / message_stop
 * shapes — so the envelope-shape bug class cannot recur.
 */

export function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function randomMsgId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return (
    "msg_" +
    Array.from(bytes, (b: number): string => b.toString(16).padStart(2, "0")).join("")
  )
}

type CurrentBlock =
  | { kind: "text"; index: number }
  | { kind: "tool"; index: number }
  | null

type StopReason = "end_turn" | "max_tokens" | "tool_use"

/**
 * Owns the single-open-block invariant and message envelope. Generator
 * methods each yield SSE strings; callers use `yield*` to forward them.
 */
export class AnthropicBlockEmitter {
  private originalModel: string
  private _started = false
  private _terminalEmitted = false
  private nextIndex = 0
  private _sawTool = false
  private current: CurrentBlock = null

  constructor(originalModel: string) {
    this.originalModel = originalModel
  }

  get started(): boolean {
    return this._started
  }

  get terminalEmitted(): boolean {
    return this._terminalEmitted
  }

  get sawTool(): boolean {
    return this._sawTool
  }

  get currentKind(): "text" | "tool" | null {
    return this.current === null ? null : this.current.kind
  }

  /**
   * Mark the stream terminal without going through `finish` (e.g. codex
   * failed-path: error event + message_stop, no message_delta). Future calls
   * to finish() become no-ops via the terminalEmitted guard.
   */
  markTerminal(): void {
    this._terminalEmitted = true
  }

  *ensureStart(opts?: { id?: string; inputTokens?: number }): Generator<string, void, void> {
    if (this._started) return
    this._started = true
    yield formatSSE("message_start", {
      type: "message_start",
      message: {
        id: opts?.id ?? randomMsgId(),
        type: "message",
        role: "assistant",
        model: this.originalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: opts?.inputTokens ?? 0, output_tokens: 0 },
      },
    })
  }

  *textDelta(text: string): Generator<string, void, void> {
    yield* this.ensureStart()
    if (this.current === null || this.current.kind !== "text") {
      yield* this.closeCurrent()
      if (this.current === null) {
        const idx = this.nextIndex++
        yield formatSSE("content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: { type: "text", text: "" },
        })
        this.current = { kind: "text", index: idx }
      }
    }
    if (text !== "") {
      yield formatSSE("content_block_delta", {
        type: "content_block_delta",
        index: this.current!.index,
        delta: { type: "text_delta", text },
      })
    }
  }

  *openTool(id: string, name: string): Generator<string, void, void> {
    yield* this.ensureStart()
    yield* this.closeCurrent()
    const idx = this.nextIndex++
    yield formatSSE("content_block_start", {
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id, name, input: {} },
    })
    yield formatSSE("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "input_json_delta", partial_json: "" },
    })
    this.current = { kind: "tool", index: idx }
    this._sawTool = true
  }

  *toolArgsDelta(fragment: string): Generator<string, void, void> {
    if (this.current === null || this.current.kind !== "tool") return
    if (fragment === "") return
    yield formatSSE("content_block_delta", {
      type: "content_block_delta",
      index: this.current.index,
      delta: { type: "input_json_delta", partial_json: fragment },
    })
  }

  *closeCurrent(): Generator<string, void, void> {
    if (this.current === null) return
    yield formatSSE("content_block_stop", {
      type: "content_block_stop",
      index: this.current.index,
    })
    this.current = null
  }

  *finish(stopReason: StopReason, outputTokens: number): Generator<string, void, void> {
    if (this._terminalEmitted) return
    yield* this.ensureStart()
    yield* this.closeCurrent()
    yield formatSSE("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    yield formatSSE("message_stop", { type: "message_stop" })
    this._terminalEmitted = true
  }
}
