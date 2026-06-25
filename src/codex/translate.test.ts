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

  test("maps max_tokens to max_output_tokens", () => {
    const result = anthropicToResponses(
      { messages: [], max_tokens: 100 },
      "x"
    )
    expect(result.max_output_tokens).toBe(100)
  })

  test("translates multiple text blocks to separate input_text items", () => {
    const result = anthropicToResponses(
      { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      "x"
    )
    expect(result.input[0].content).toEqual([
      { type: "input_text", text: "a" },
      { type: "input_text", text: "b" },
    ])
  })
})
