import type { CcrouteConfig, ResolvedRoute, SubagentRoute } from "./config"
import { anthropicModelRejectMessage } from "./errors"

export interface CatalogEntry {
  upstream: "codex" | "opencode"
  endpointPath: "/v1/messages" | "/v1/chat/completions" | "/backend-api/codex/responses"
  displayName: string
}

export const MODEL_CATALOG: ReadonlyMap<string, CatalogEntry> = new Map<string, CatalogEntry>([
  ["minimax-m3", { upstream: "opencode", endpointPath: "/v1/messages", displayName: "MiniMax M3" }],
  ["minimax-m2.7", { upstream: "opencode", endpointPath: "/v1/messages", displayName: "MiniMax M2.7" }],
  ["minimax-m2.5", { upstream: "opencode", endpointPath: "/v1/messages", displayName: "MiniMax M2.5" }],
  ["qwen3.7-max", { upstream: "opencode", endpointPath: "/v1/messages", displayName: "Qwen 3.7 Max" }],
  ["qwen3.7-plus", { upstream: "opencode", endpointPath: "/v1/messages", displayName: "Qwen 3.7 Plus" }],
  ["qwen3.6-plus", { upstream: "opencode", endpointPath: "/v1/messages", displayName: "Qwen 3.6 Plus" }],
  ["glm-5.2", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "GLM 5.2" }],
  ["glm-5.1", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "GLM 5.1" }],
  ["kimi-k2.7", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "Kimi K2.7" }],
  ["kimi-k2.6", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "Kimi K2.6" }],
  ["deepseek-v4-pro", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "DeepSeek V4 Pro" }],
  ["deepseek-v4-flash", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "DeepSeek V4 Flash" }],
  ["mimo-v2.5", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "MIMO V2.5" }],
  ["mimo-v2.5-pro", { upstream: "opencode", endpointPath: "/v1/chat/completions", displayName: "MIMO V2.5 Pro" }],
])

export type RouteResult =
  | { kind: "resolved"; route: ResolvedRoute; originalModel: string; matchedAgent: string | null }
  | { kind: "anthropic-passthrough"; originalModel: string }
  | { kind: "anthropic-reject"; message: string }
  | { kind: "unknown-model"; message: string }
  | { kind: "not-allowed"; message: string }

function resolveEndpoint(upstream: "codex" | "opencode", modelId: string): ResolvedRoute["endpointPath"] {
  if (upstream === "codex") return "/backend-api/codex/responses"
  const entry = MODEL_CATALOG.get(modelId)
  if (entry) return entry.endpointPath
  return "/v1/messages"
}

const CODEX_PATTERN = /^(gpt-|o\d|codex-)/
const ANTHROPIC_PATTERN = /^claude-/
const ANTHROPIC_KEYWORDS = /sonnet|opus|haiku/i

export function detectSubagent(systemBlocks: unknown[], config: CcrouteConfig): SubagentRoute | null {
  if (!systemBlocks || systemBlocks.length === 0) return null
  const first = systemBlocks[0]
  let text: string
  if (typeof first === "string") {
    text = first
  } else if (Array.isArray(first)) {
    text = (first as Array<{ type?: string; text?: string }>)
      .filter(b => b?.type === "text")
      .map(b => b.text ?? "")
      .join("\n")
  } else if (first !== null && typeof first === "object" && "type" in first) {
    text = (systemBlocks as Array<{ type?: string; text?: string }>)
      .filter(b => b?.type === "text")
      .map(b => b.text ?? "")
      .join("\n")
  } else {
    return null
  }
  if (!text) return null
  for (const route of config.subagentRoutes) {
    if (!route.match) continue
    if (text.includes(route.match)) return route
  }
  return null
}

export function resolveRoute(modelId: string, systemBlocks: unknown[], config: CcrouteConfig): RouteResult {
  const subagent = detectSubagent(systemBlocks, config)
  if (subagent) {
    return {
      kind: "resolved",
      route: {
        upstream: subagent.upstream,
        upstreamModelId: subagent.model,
        endpointPath: resolveEndpoint(subagent.upstream, subagent.model),
      },
      originalModel: modelId,
      matchedAgent: subagent.match,
    }
  }

  for (const route of config.modelRoutes) {
    if (modelId === route.match) {
      return {
        kind: "resolved",
        route: {
          upstream: route.upstream,
          upstreamModelId: route.model,
          endpointPath: resolveEndpoint(route.upstream, route.model),
        },
        originalModel: modelId,
        matchedAgent: null,
      }
    }
  }

  const catalogEntry = MODEL_CATALOG.get(modelId)
  if (catalogEntry) {
    return {
      kind: "resolved",
      route: {
        upstream: catalogEntry.upstream,
        upstreamModelId: modelId,
        endpointPath: catalogEntry.endpointPath,
      },
      originalModel: modelId,
      matchedAgent: null,
    }
  }

  if (CODEX_PATTERN.test(modelId)) {
    const allowed = config.codex.allowedModels
    if (allowed && allowed.length > 0 && !allowed.includes(modelId)) {
      return {
        kind: "not-allowed",
        message: `Model "${modelId}" is not in the Codex allowed list. Allowed: ${allowed.join(", ")}`,
      }
    }
    return {
      kind: "resolved",
      route: {
        upstream: "codex",
        upstreamModelId: modelId,
        endpointPath: "/backend-api/codex/responses",
      },
      originalModel: modelId,
      matchedAgent: null,
    }
  }

  if (ANTHROPIC_PATTERN.test(modelId) || ANTHROPIC_KEYWORDS.test(modelId)) {
    if (config.anthropic.passthrough) {
      return { kind: "anthropic-passthrough", originalModel: modelId }
    }
    return {
      kind: "anthropic-reject",
      message: anthropicModelRejectMessage(modelId),
    }
  }

  const knownModels = Array.from(MODEL_CATALOG.keys()).join(", ")
  return {
    kind: "unknown-model",
    message: `Unknown model "${modelId}". Known models: ${knownModels}. Also accepts any gpt-*/o*/codex-* for Codex.`,
  }
}

export function listAdvertisedModels(_config: CcrouteConfig): Array<{ id: string; upstream: string; displayName: string }> {
  const models: Array<{ id: string; upstream: string; displayName: string }> = []
  for (const [id, entry] of MODEL_CATALOG) {
    models.push({ id, upstream: entry.upstream, displayName: entry.displayName })
  }
  models.push({ id: "gpt-*", upstream: "codex", displayName: "Any GPT model via Codex (ChatGPT Pro)" })
  return models
}

