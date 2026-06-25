import { describe, test, expect } from "bun:test"
import { anthropicToOpenAI, openAIToAnthropicMessage } from "./translate"

describe("anthropicToOpenAI", () => {
  test("basic user message with max_tokens", () => {
    const result = anthropicToOpenAI(
      { messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
      "glm-5.2"
    )
    expect(result.model).toBe("glm-5.2")
    expect(result.stream).toBe(true)
    expect(result.max_tokens).toBe(100)
    expect(result.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("system as string prepends system message", () => {
    const result = anthropicToOpenAI(
      { system: "You are X", messages: [{ role: "user", content: "hi" }] },
      "x"
    )
    expect(result.messages[0]).toEqual({ role: "system", content: "You are X" })
    expect(result.messages[1]).toEqual({ role: "user", content: "hi" })
  })

  test("system as array of text blocks joined with double newline", () => {
    const result = anthropicToOpenAI(
      {
        system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
        messages: [{ role: "user", content: "hi" }],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({ role: "system", content: "A\n\nB" })
  })

  test("user content as array of text blocks joined with newline", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({ role: "user", content: "a\nb" })
  })

  test("assistant with tool_use blocks stripped to empty content", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          { role: "assistant", content: [{ type: "tool_use", name: "f", input: {} }] },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({ role: "assistant", content: "" })
  })

  test("user with tool_result blocks stripped to empty content", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "r" }] },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({ role: "user", content: "" })
  })

  test("throws on non-object body", () => {
    expect(() => anthropicToOpenAI("string", "x")).toThrow()
    expect(() => anthropicToOpenAI(null, "x")).toThrow()
    expect(() => anthropicToOpenAI(42, "x")).toThrow()
  })

  test("temperature and top_p pass through", () => {
    const result = anthropicToOpenAI(
      { messages: [], temperature: 0.5, top_p: 0.9 },
      "x"
    )
    expect(result.temperature).toBe(0.5)
    expect(result.top_p).toBe(0.9)
  })

  test("discards Anthropic-specific fields", () => {
    const result = anthropicToOpenAI(
      {
        messages: [],
        stop_sequences: ["END"],
        metadata: { user_id: "u1" },
        thinking: { type: "enabled" },
      },
      "x"
    )
    expect(result).not.toHaveProperty("stop_sequences")
    expect(result).not.toHaveProperty("metadata")
    expect(result).not.toHaveProperty("thinking")
  })
})

describe("openAIToAnthropicMessage", () => {
  test("maps stop finish_reason to end_turn", () => {
    const result = openAIToAnthropicMessage(
      {
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      "glm-5.2"
    )
    expect(result.model).toBe("glm-5.2")
    expect(result.role).toBe("assistant")
    expect(result.type).toBe("message")
    expect(result.stop_reason).toBe("end_turn")
    expect(result.content).toEqual([{ type: "text", text: "hello" }])
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
    expect(result.id).toMatch(/^msg_[0-9a-f]{32}$/)
  })

  test("maps length finish_reason to max_tokens", () => {
    const result = openAIToAnthropicMessage(
      {
        choices: [{ message: { content: "partial" }, finish_reason: "length" }],
        usage: { prompt_tokens: 5, completion_tokens: 100 },
      },
      "m"
    )
    expect(result.stop_reason).toBe("max_tokens")
  })

  test("maps tool_calls finish_reason to tool_use", () => {
    const result = openAIToAnthropicMessage(
      {
        choices: [{ message: { content: "" }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 20 },
      },
      "m"
    )
    expect(result.stop_reason).toBe("tool_use")
  })
})
