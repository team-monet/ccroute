import { encode } from "gpt-tokenizer/encoding/o200k_base"

export function countTokens(text: string): number {
  return encode(text).length
}

export function countMessagesTokens(messages: unknown[]): number {
  let total = 0
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue
    const msg = m as Record<string, unknown>
    if (typeof msg["role"] === "string") total += countTokens(msg["role"] as string) + 4
    const content = msg["content"]
    if (typeof content === "string") {
      total += countTokens(content)
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue
        const b = block as Record<string, unknown>
        if (b["type"] === "text" && typeof b["text"] === "string") {
          total += countTokens(b["text"] as string)
        } else if (b["type"] === "tool_use" || b["type"] === "tool_result") {
          total += 20
        } else {
          total += 10
        }
      }
    }
  }
  return total
}

export function countRequestTokens(body: unknown): { input_tokens: number } {
  if (typeof body !== "object" || body === null) return { input_tokens: 0 }
  const b = body as Record<string, unknown>
  let total = 0
  if (b["system"] !== undefined) total += countSystemTokens(b["system"])
  if (Array.isArray(b["messages"])) total += countMessagesTokens(b["messages"])
  if (Array.isArray(b["tools"])) total += countToolsTokens(b["tools"])
  return { input_tokens: total }
}

function countSystemTokens(system: unknown): number {
  if (typeof system === "string") return countTokens(system)
  if (Array.isArray(system)) {
    let total = 0
    for (const block of system) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>
        if (b["type"] === "text" && typeof b["text"] === "string") total += countTokens(b["text"] as string)
      }
    }
    return total
  }
  return 0
}

function countToolsTokens(tools: unknown[]): number {
  let total = 0
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) continue
    const t = tool as Record<string, unknown>
    total += countTokens((t["name"] as string) ?? "")
    total += countTokens((t["description"] as string) ?? "")
    if (t["input_schema"]) total += countTokens(JSON.stringify(t["input_schema"]))
  }
  return total
}
