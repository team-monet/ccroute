import { describe, test, expect } from "bun:test"
import { anthropicToResponses } from "./translate"

describe("anthropicToResponses", () => {
  test("translates basic system + user message", () => {
    const result = anthropicToResponses(
      { system: "You are X", messages: [{ role: "user", content: "hi" }] },
      "gpt-4.1"
    )
    expect(result.model).toBe("gpt-4.1")
    expect(result.instructions).toBe("You are X")
    expect(result.stream).toBe(true)
    expect(result.store).toBe(false)
    expect(result.parallel_tool_calls).toBe(true)
    expect(result.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ])
  })

  test("joins system array blocks with double newline", () => {
    const result = anthropicToResponses(
      { system: [{ type: "text", text: "A" }, { type: "text", text: "B" }], messages: [] },
      "x"
    )
    expect(result.instructions).toBe("A\n\nB")
  })

  test("strips x-anthropic-billing-header lines from system", () => {
    const result = anthropicToResponses(
      { system: "x-anthropic-billing-header: foo\nYou are X", messages: [] },
      "x"
    )
    expect(result.instructions).toBe("You are X")
  })

  test("maps output_config.effort max to reasoning.effort xhigh", () => {
    const result = anthropicToResponses(
      { output_config: { effort: "max" }, messages: [] },
      "x"
    )
    expect(result.reasoning).toEqual({ effort: "xhigh" })
  })

  test("does not send max_output_tokens even when max_tokens is provided", () => {
    const result = anthropicToResponses(
      { messages: [], max_tokens: 100 },
      "x"
    )
    expect(result.max_output_tokens).toBeUndefined()
  })

  test("concatenates adjacent text blocks within a message into a single input_text", () => {
    const result = anthropicToResponses(
      { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      "x"
    )
    const first = result.input[0] as { type: "message"; content: Array<{ type: string; text: string }> }
    expect(first.content).toEqual([
      { type: "input_text", text: "ab" },
    ])
  })

  describe("tools mapping", () => {
    test("maps Anthropic tools to function tools with input_schema as parameters", () => {
      const result = anthropicToResponses(
        {
          messages: [],
          tools: [
            {
              name: "read_file",
              description: "Read a file from disk",
              input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
          ],
        },
        "x"
      )
      expect(result.tools).toEqual([
        {
          type: "function",
          name: "read_file",
          description: "Read a file from disk",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          strict: false,
        },
      ])
    })

    test("omits tools array when input is empty", () => {
      const result = anthropicToResponses({ messages: [], tools: [] }, "x")
      expect(result.tools).toBeUndefined()
    })

    test("omits description when not provided", () => {
      const result = anthropicToResponses(
        {
          messages: [],
          tools: [{ name: "noop", input_schema: {} }],
        },
        "x"
      )
      expect(result.tools).toEqual([
        { type: "function", name: "noop", parameters: {}, strict: false },
      ])
    })

    test("skips tools with non-string name", () => {
      const result = anthropicToResponses(
        {
          messages: [],
          tools: [
            { name: "good", input_schema: {} },
            { input_schema: {} },
          ],
        },
        "x"
      )
      expect(result.tools).toHaveLength(1)
      expect(result.tools![0].name).toBe("good")
    })
  })

  describe("tool_choice mapping", () => {
    test("maps auto to auto", () => {
      const result = anthropicToResponses(
        { messages: [], tool_choice: "auto" },
        "x"
      )
      expect(result.tool_choice).toBe("auto")
    })

    test("maps any to required", () => {
      const result = anthropicToResponses(
        { messages: [], tool_choice: "any" },
        "x"
      )
      expect(result.tool_choice).toBe("required")
    })

    test("maps none to none", () => {
      const result = anthropicToResponses(
        { messages: [], tool_choice: "none" },
        "x"
      )
      expect(result.tool_choice).toBe("none")
    })

    test("maps named tool choice to function name", () => {
      const result = anthropicToResponses(
        { messages: [], tool_choice: { type: "tool", name: "read_file" } },
        "x"
      )
      expect(result.tool_choice).toEqual({ type: "function", name: "read_file" })
    })

    test("omits tool_choice when not provided", () => {
      const result = anthropicToResponses({ messages: [] }, "x")
      expect(result.tool_choice).toBeUndefined()
    })
  })

  describe("assistant tool_use blocks", () => {
    test("translates assistant text+tool_use to message item then function_call item", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Let me read that file." },
                { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "/tmp/x.txt" } },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toEqual([
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Let me read that file." }],
        },
        {
          type: "function_call",
          call_id: "toolu_01",
          name: "read_file",
          arguments: JSON.stringify({ path: "/tmp/x.txt" }),
        },
      ])
    })

    test("emits multiple function_call items for parallel tool_use in one assistant turn", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "/a" } },
                { type: "tool_use", id: "toolu_02", name: "read_file", input: { path: "/b" } },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toHaveLength(2)
      expect(result.input[0]).toEqual({
        type: "function_call",
        call_id: "toolu_01",
        name: "read_file",
        arguments: JSON.stringify({ path: "/a" }),
      })
      expect(result.input[1]).toEqual({
        type: "function_call",
        call_id: "toolu_02",
        name: "read_file",
        arguments: JSON.stringify({ path: "/b" }),
      })
    })

    test("skips tool_use with missing id or name (does not emit a function_call)", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "tool_use", name: "read_file", input: { path: "/a" } },
                { type: "tool_use", id: "toolu_01", input: { path: "/b" } },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toEqual([])
    })
  })

  describe("user tool_result blocks", () => {
    test("translates user tool_result to function_call_output with call_id and flattened output", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_01",
                  content: "file contents here",
                },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toEqual([
        {
          type: "function_call_output",
          call_id: "toolu_01",
          output: "file contents here",
        },
      ])
    })

    test("flattens tool_result content array of text blocks", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_01",
                  content: [
                    { type: "text", text: "line 1" },
                    { type: "text", text: "line 2" },
                  ],
                },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toEqual([
        {
          type: "function_call_output",
          call_id: "toolu_01",
          output: "line 1line 2",
        },
      ])
    })

    test("emits (no content) for empty tool_result output", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "toolu_01",
                  content: "",
                },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toEqual([
        {
          type: "function_call_output",
          call_id: "toolu_01",
          output: "(no content)",
        },
      ])
    })
  })

  describe("mixed text and tool block ordering", () => {
    test("preserves block order: text, tool_use, text in one assistant message", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "before" },
                { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "/a" } },
                { type: "text", text: "after" },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toHaveLength(3)
      expect(result.input[0]).toEqual({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "before" }],
      })
      expect(result.input[1]).toEqual({
        type: "function_call",
        call_id: "toolu_01",
        name: "read_file",
        arguments: JSON.stringify({ path: "/a" }),
      })
      expect(result.input[2]).toEqual({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "after" }],
      })
    })

    test("preserves block order: text, tool_result in one user message", () => {
      const result = anthropicToResponses(
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "here is the result:" },
                {
                  type: "tool_result",
                  tool_use_id: "toolu_01",
                  content: "ok",
                },
              ],
            },
          ],
        },
        "x"
      )
      expect(result.input).toHaveLength(2)
      expect(result.input[0]).toEqual({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "here is the result:" }],
      })
      expect(result.input[1]).toEqual({
        type: "function_call_output",
        call_id: "toolu_01",
        output: "ok",
      })
    })
  })
})
