import { describe, test, expect } from "bun:test"
import { resolveRoute, detectSubagent } from "./router"
import { defaultConfig } from "./config"

describe("resolveRoute", () => {
  test("minimax-m3 resolves to opencode /v1/messages", () => {
    const result = resolveRoute("minimax-m3", [], defaultConfig())
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.route.upstream).toBe("opencode")
      expect(result.route.endpointPath).toBe("/v1/messages")
      expect(result.route.upstreamModelId).toBe("minimax-m3")
    }
  })

  test("glm-5.2 resolves to opencode /v1/chat/completions", () => {
    const result = resolveRoute("glm-5.2", [], defaultConfig())
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.route.upstream).toBe("opencode")
      expect(result.route.endpointPath).toBe("/v1/chat/completions")
      expect(result.route.upstreamModelId).toBe("glm-5.2")
    }
  })

  test("gpt-4.1 resolves to codex", () => {
    const result = resolveRoute("gpt-4.1", [], defaultConfig())
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.route.upstream).toBe("codex")
      expect(result.route.upstreamModelId).toBe("gpt-4.1")
      expect(result.route.endpointPath).toBe("/backend-api/codex/responses")
    }
  })

  test("claude-sonnet-4-6 is anthropic-passthrough when passthrough enabled (default)", () => {
    const result = resolveRoute("claude-sonnet-4-6", [], defaultConfig())
    expect(result.kind).toBe("anthropic-passthrough")
    if (result.kind === "anthropic-passthrough") {
      expect(result.originalModel).toBe("claude-sonnet-4-6")
    }
  })

  test("claude-opus-4-8 is anthropic-passthrough (matches claude- prefix)", () => {
    const result = resolveRoute("claude-opus-4-8", [], defaultConfig())
    expect(result.kind).toBe("anthropic-passthrough")
    if (result.kind === "anthropic-passthrough") {
      expect(result.originalModel).toBe("claude-opus-4-8")
    }
  })

  test("some-sonnet-model is anthropic-passthrough (matches sonnet keyword)", () => {
    const result = resolveRoute("some-sonnet-model", [], defaultConfig())
    expect(result.kind).toBe("anthropic-passthrough")
    if (result.kind === "anthropic-passthrough") {
      expect(result.originalModel).toBe("some-sonnet-model")
    }
  })

  test("claude-opus-4-8 is anthropic-reject when passthrough disabled", () => {
    const cfg = defaultConfig()
    const noPassthrough = { ...cfg, anthropic: { ...cfg.anthropic, passthrough: false } }
    const result = resolveRoute("claude-opus-4-8", [], noPassthrough)
    expect(result.kind).toBe("anthropic-reject")
  })

  test("claude-sonnet-4-6 is anthropic-reject when passthrough disabled", () => {
    const cfg = defaultConfig()
    const noPassthrough = { ...cfg, anthropic: { ...cfg.anthropic, passthrough: false } }
    const result = resolveRoute("claude-sonnet-4-6", [], noPassthrough)
    expect(result.kind).toBe("anthropic-reject")
  })

  test("unknown-model-xyz is unknown-model", () => {
    const result = resolveRoute("unknown-model-xyz", [], defaultConfig())
    expect(result.kind).toBe("unknown-model")
  })

  test("gpt-4.1 with restrictive allowlist is not-allowed", () => {
    const cfg = defaultConfig()
    const restricted = {
      ...cfg,
      codex: { ...cfg.codex, allowedModels: ["gpt-4o"] },
    }
    const result = resolveRoute("gpt-4.1", [], restricted)
    expect(result.kind).toBe("not-allowed")
  })

  test("subagent override routes reviewer to opencode minimax-m3", () => {
    const cfg = {
      ...defaultConfig(),
      subagentRoutes: [
        { match: "You are the **reviewer**", upstream: "opencode" as const, model: "minimax-m3" },
      ],
    }
    const systemBlocks = [{ type: "text", text: "You are the **reviewer**" }]
    const result = resolveRoute("some-other-model", systemBlocks, cfg)
    expect(result.kind).toBe("resolved")
    if (result.kind === "resolved") {
      expect(result.route.upstream).toBe("opencode")
      expect(result.route.upstreamModelId).toBe("minimax-m3")
      expect(result.route.endpointPath).toBe("/v1/messages")
    }
  })
})

describe("detectSubagent", () => {
  test("detects explorer from text block", () => {
    const cfg = {
      ...defaultConfig(),
      subagentRoutes: [
        { match: "You are the **explorer**", upstream: "opencode" as const, model: "minimax-m3" },
      ],
    }
    const result = detectSubagent([{ type: "text", text: "You are the **explorer**" }], cfg)
    expect(result).not.toBeNull()
    expect(result!.upstream).toBe("opencode")
    expect(result!.model).toBe("minimax-m3")
  })

  test("returns null for empty systemBlocks", () => {
    const result = detectSubagent([], defaultConfig())
    expect(result).toBeNull()
  })

  test("returns null for null systemBlocks", () => {
    const result = detectSubagent(null as unknown as [], defaultConfig())
    expect(result).toBeNull()
  })
})
