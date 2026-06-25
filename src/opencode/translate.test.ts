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
          { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "f", input: {} }] },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
      ],
    })
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
    expect(result.messages[0]).toEqual({ role: "tool", tool_call_id: "1", content: "r" })
  })

  test("tools array maps input_schema to function parameters", () => {
    const result = anthropicToOpenAI(
      {
        tools: [
          {
            name: "get_weather",
            description: "Get the current weather",
            input_schema: { type: "object", properties: { city: { type: "string" } } },
          },
        ],
        messages: [{ role: "user", content: "hi" }],
      },
      "x"
    )
    expect(result.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ])
  })

  test("tools entries with no description omit the field", () => {
    const result = anthropicToOpenAI(
      {
        tools: [{ name: "f", input_schema: {} }],
        messages: [],
      },
      "x"
    )
    expect(result.tools).toEqual([
      { type: "function", function: { name: "f", parameters: {} } },
    ])
  })

  test("tool_choice auto maps to auto", () => {
    const result = anthropicToOpenAI(
      { tool_choice: "auto", messages: [] },
      "x"
    )
    expect(result.tool_choice).toBe("auto")
  })

  test("tool_choice any maps to required", () => {
    const result = anthropicToOpenAI(
      { tool_choice: "any", messages: [] },
      "x"
    )
    expect(result.tool_choice).toBe("required")
  })

  test("tool_choice named tool maps to function choice", () => {
    const result = anthropicToOpenAI(
      { tool_choice: { type: "tool", name: "f" }, messages: [] },
      "x"
    )
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "f" },
    })
  })

  // FIX 3: the object branch must map all object-form values, not just
  // {type:"tool",name}. The string "none" must also pass through.
  test("object-form tool_choice {type:'any'} maps to 'required'", () => {
    const result = anthropicToOpenAI(
      { tool_choice: { type: "any" }, messages: [] },
      "x"
    )
    expect(result.tool_choice).toBe("required")
  })

  test("object-form tool_choice {type:'none'} maps to 'none'", () => {
    const result = anthropicToOpenAI(
      { tool_choice: { type: "none" }, messages: [] },
      "x"
    )
    expect(result.tool_choice).toBe("none")
  })

  test("object-form tool_choice {type:'auto'} maps to 'auto'", () => {
    const result = anthropicToOpenAI(
      { tool_choice: { type: "auto" }, messages: [] },
      "x"
    )
    expect(result.tool_choice).toBe("auto")
  })

  test("object-form tool_choice {type:'tool',name:'X'} maps to function choice", () => {
    const result = anthropicToOpenAI(
      { tool_choice: { type: "tool", name: "X" }, messages: [] },
      "x"
    )
    expect(result.tool_choice).toEqual({
      type: "function",
      function: { name: "X" },
    })
  })

  test("string-form tool_choice 'none' maps to 'none'", () => {
    const result = anthropicToOpenAI(
      { tool_choice: "none", messages: [] },
      "x"
    )
    expect(result.tool_choice).toBe("none")
  })

  test("tool_choice absent is omitted", () => {
    const result = anthropicToOpenAI({ messages: [] }, "x")
    expect(result).not.toHaveProperty("tool_choice")
  })

  test("assistant single tool_use maps to tool_calls", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "f", input: { a: 1 } }],
          },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
      ],
    })
  })

  test("assistant mixed text and tool_use preserves order", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me look that up." },
              { type: "tool_use", id: "call_1", name: "f", input: { q: "weather" } },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "Let me look that up.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "f", arguments: '{"q":"weather"}' } },
      ],
    })
  })

  test("assistant parallel tool_use blocks become multiple tool_calls", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call_1", name: "f1", input: { a: 1 } },
              { type: "tool_use", id: "call_2", name: "f2", input: { b: 2 } },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "f1", arguments: '{"a":1}' } },
        { id: "call_2", type: "function", function: { name: "f2", arguments: '{"b":2}' } },
      ],
    })
  })

  test("user multiple tool_results become multiple role:tool messages", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "r1" },
              { type: "tool_result", tool_use_id: "call_2", content: "r2" },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "r1" },
      { role: "tool", tool_call_id: "call_2", content: "r2" },
    ])
  })

  test("user tool_result then text puts tool messages first, then user text", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "r1" },
              { type: "text", text: "thanks" },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "r1" },
      { role: "user", content: "thanks" },
    ])
  })

  test("user tool_result with array content is flattened to text", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_1",
                content: [
                  { type: "text", text: "line1" },
                  { type: "text", text: "line2" },
                ],
              },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "line1\nline2",
    })
  })

  test("user turn with only tool_results does not emit an empty user message", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "r1" },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe("tool")
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

  test("tool_calls becomes tool_use blocks in content", () => {
    const result = openAIToAnthropicMessage(
      {
        choices: [{
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: '{"a":1}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      },
      "m"
    )
    expect(result.stop_reason).toBe("tool_use")
    expect(result.content).toEqual([
      { type: "tool_use", id: "call_1", name: "f", input: { a: 1 } },
    ])
  })

  test("text and tool_calls both appear in content", () => {
    const result = openAIToAnthropicMessage(
      {
        choices: [{
          message: {
            content: "Here you go:",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: '{"x":"y"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        }],
      },
      "m"
    )
    expect(result.content).toEqual([
      { type: "text", text: "Here you go:" },
      { type: "tool_use", id: "call_1", name: "f", input: { x: "y" } },
    ])
  })

  test("malformed tool_call arguments fall back to empty input", () => {
    const result = openAIToAnthropicMessage(
      {
        choices: [{
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: "{not json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        }],
      },
      "m"
    )
    expect(result.content).toEqual([
      { type: "tool_use", id: "call_1", name: "f", input: {} },
    ])
  })

  test("tool_call with missing id is dropped and warns", () => {
    // The warn() call fires as a side effect; we verify the contract: no
    // tool_use block is emitted when id is missing/empty.
    const result = openAIToAnthropicMessage(
      {
        choices: [{
          message: {
            content: "",
            tool_calls: [
              {
                id: "",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        }],
      },
      "m"
    )
    expect(result.content).toEqual([])
  })

  test("empty tool_result content falls back to '(no content)'", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: "" },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "(no content)",
    })
  })

  // FIX 6: a tool_result block missing tool_use_id must be dropped (warned)
  // rather than producing a role:"tool" message with undefined tool_call_id.
  test("tool_result with missing tool_use_id is dropped", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", content: "result" },
            ],
          },
        ],
      },
      "x"
    )
    // No role:"tool" message should be produced for the malformed block.
    const toolMessages = result.messages.filter(m => m.role === "tool")
    expect(toolMessages).toHaveLength(0)
    expect(result.messages).toHaveLength(0)
  })

  test("tool_result with missing tool_use_id does not affect subsequent blocks", () => {
    const result = anthropicToOpenAI(
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", content: "bad" },
              { type: "tool_result", tool_use_id: "call_ok", content: "good" },
              { type: "text", text: "after" },
            ],
          },
        ],
      },
      "x"
    )
    expect(result.messages).toEqual([
      { role: "tool", tool_call_id: "call_ok", content: "good" },
      { role: "user", content: "after" },
    ])
  })
})
