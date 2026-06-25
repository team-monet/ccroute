/// <reference types="bun-types" />
import { TOML } from "bun"
import { existsSync, mkdirSync, readdirSync, readFileSync, openSync, writeSync, closeSync, chmodSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"

export interface SubagentRoute {
  match: string
  upstream: "codex" | "opencode"
  model: string
}

export interface ModelRouteOverride {
  match: string
  upstream: "codex" | "opencode"
  model: string
}

export interface ResolvedRoute {
  upstream: "codex" | "opencode"
  upstreamModelId: string
  endpointPath: "/v1/messages" | "/v1/chat/completions" | "/backend-api/codex/responses"
}

export interface CcrouteConfig {
  port: number
  codex: {
    baseUrl: string
    effort: "low" | "medium" | "high"
    serviceTier: string
    allowedModels?: string[]
  }
  opencode: {
    baseUrl: string
  }
  subagentRoutes: SubagentRoute[]
  modelRoutes: ModelRouteOverride[]
}

function configDir(): string {
  return join(homedir(), ".config", "ccroute")
}

function configPath(): string {
  return join(configDir(), "config.toml")
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 })
}

function escapeTomlString(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

function serializeToml(config: CcrouteConfig): string {
  const lines: string[] = []

  lines.push(`port = ${config.port}`)
  lines.push("")

  lines.push("[codex]")
  lines.push(`baseUrl = "${escapeTomlString(config.codex.baseUrl)}"`)
  lines.push(`effort = "${escapeTomlString(config.codex.effort)}"`)
  lines.push(`serviceTier = "${escapeTomlString(config.codex.serviceTier)}"`)
  if (config.codex.allowedModels && config.codex.allowedModels.length > 0) {
    const items = config.codex.allowedModels.map(m => `"${escapeTomlString(m)}"`).join(", ")
    lines.push(`allowedModels = [${items}]`)
  }
  lines.push("")

  lines.push("[opencode]")
  lines.push(`baseUrl = "${escapeTomlString(config.opencode.baseUrl)}"`)
  lines.push("")

  for (const route of config.subagentRoutes) {
    lines.push("[[subagentRoutes]]")
    lines.push(`match = "${escapeTomlString(route.match)}"`)
    lines.push(`upstream = "${escapeTomlString(route.upstream)}"`)
    lines.push(`model = "${escapeTomlString(route.model)}"`)
    lines.push("")
  }

  for (const route of config.modelRoutes) {
    lines.push("[[modelRoutes]]")
    lines.push(`match = "${escapeTomlString(route.match)}"`)
    lines.push(`upstream = "${escapeTomlString(route.upstream)}"`)
    lines.push(`model = "${escapeTomlString(route.model)}"`)
    lines.push("")
  }

  return lines.join("\n")
}

export function autoDetectSubagentRoutes(): SubagentRoute[] {
  const agentsDir = join(homedir(), ".claude", "agents")
  if (!existsSync(agentsDir)) return []

  let entries: string[]
  try {
    entries = readdirSync(agentsDir)
  } catch {
    return []
  }

  const routes: SubagentRoute[] = []
  const regex = /You are the \*\*(\w+)\*\*/

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    if (entry.endsWith(".bak")) continue

    const fullPath = join(agentsDir, entry)
    let stat
    try {
      stat = statSync(fullPath)
    } catch {
      continue
    }
    if (!stat.isFile()) continue

    let content: string
    try {
      content = readFileSync(fullPath, "utf-8")
    } catch {
      continue
    }

    const matches = content.matchAll(new RegExp(regex, "g"))
    for (const m of matches) {
      const name = m[1]
      routes.push({
        match: `You are the **${name}**`,
        upstream: "opencode",
        model: "minimax-m3",
      })
    }
  }

  return routes
}

export function defaultConfig(): CcrouteConfig {
  return {
    port: 18765,
    codex: {
      baseUrl: "https://chatgpt.com",
      effort: "high",
      serviceTier: "default",
    },
    opencode: {
      baseUrl: "https://opencode.ai/zen/go",
    },
    subagentRoutes: autoDetectSubagentRoutes(),
    modelRoutes: [],
  }
}

function deepMerge(defaults: CcrouteConfig, raw: Record<string, unknown>): CcrouteConfig {
  const result = { ...defaults }

  if (typeof raw["port"] === "number") result.port = raw["port"] as number

  if (raw["codex"] && typeof raw["codex"] === "object") {
    const c = raw["codex"] as Record<string, unknown>
    result.codex = { ...defaults.codex }
    if (typeof c["baseUrl"] === "string") result.codex.baseUrl = c["baseUrl"] as string
    if (typeof c["effort"] === "string") result.codex.effort = c["effort"] as "low" | "medium" | "high"
    if (typeof c["serviceTier"] === "string") result.codex.serviceTier = c["serviceTier"] as string
    if (Array.isArray(c["allowedModels"])) {
      result.codex.allowedModels = (c["allowedModels"] as unknown[]).filter((x): x is string => typeof x === "string")
    }
  }

  if (raw["opencode"] && typeof raw["opencode"] === "object") {
    const o = raw["opencode"] as Record<string, unknown>
    result.opencode = { ...defaults.opencode }
    if (typeof o["baseUrl"] === "string") result.opencode.baseUrl = o["baseUrl"] as string
  }

  if (Array.isArray(raw["subagentRoutes"])) {
    result.subagentRoutes = (raw["subagentRoutes"] as unknown[])
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map(r => ({
        match: typeof r["match"] === "string" ? (r["match"] as string) : "",
        upstream: (typeof r["upstream"] === "string" && (r["upstream"] === "codex" || r["upstream"] === "opencode"))
          ? r["upstream"] as "codex" | "opencode"
          : "opencode" as const,
        model: typeof r["model"] === "string" ? (r["model"] as string) : "",
      }))
  }

  if (Array.isArray(raw["modelRoutes"])) {
    result.modelRoutes = (raw["modelRoutes"] as unknown[])
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
      .map(r => ({
        match: typeof r["match"] === "string" ? (r["match"] as string) : "",
        upstream: (typeof r["upstream"] === "string" && (r["upstream"] === "codex" || r["upstream"] === "opencode"))
          ? r["upstream"] as "codex" | "opencode"
          : "opencode" as const,
        model: typeof r["model"] === "string" ? (r["model"] as string) : "",
      }))
  }

  return result
}

function validateConfig(raw: unknown): CcrouteConfig {
  if (raw === null || typeof raw !== "object") {
    throw new Error("config must be an object")
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj["port"] !== "number" || !Number.isInteger(obj["port"]) || (obj["port"] as number) <= 0) {
    throw new Error(`config.port must be a positive integer, got: ${obj["port"]}`)
  }

  if (obj["codex"] && typeof obj["codex"] === "object") {
    const c = obj["codex"] as Record<string, unknown>
    if (c["effort"] !== undefined) {
      const validEfforts = ["low", "medium", "high"]
      if (!validEfforts.includes(c["effort"] as string)) {
        throw new Error(`config.codex.effort must be one of ${validEfforts.join(", ")}, got: ${c["effort"]}`)
      }
    }
  }

  if (Array.isArray(obj["subagentRoutes"])) {
    const routes = obj["subagentRoutes"] as unknown[]
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i] as Record<string, unknown>
      if (typeof r["match"] === "string" && (r["match"] as string) === "") {
        throw new Error(`config.subagentRoutes[${i}].match must not be empty`)
      }
      if (r["upstream"] !== undefined && r["upstream"] !== "codex" && r["upstream"] !== "opencode") {
        throw new Error(`config.subagentRoutes[${i}].upstream must be "codex" or "opencode", got: ${r["upstream"]}`)
      }
    }
  }

  if (Array.isArray(obj["modelRoutes"])) {
    const routes = obj["modelRoutes"] as unknown[]
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i] as Record<string, unknown>
      if (r["upstream"] !== undefined && r["upstream"] !== "codex" && r["upstream"] !== "opencode") {
        throw new Error(`config.modelRoutes[${i}].upstream must be "codex" or "opencode", got: ${r["upstream"]}`)
      }
    }
  }

  const defaults = defaultConfig()
  return deepMerge(defaults, obj)
}

export function loadConfig(): CcrouteConfig {
  const path = configPath()

  if (!existsSync(path)) {
    const config = defaultConfig()
    saveConfig(config)
    return config
  }

  const content = readFileSync(path, "utf-8")
  const parsed = TOML.parse(content)
  return validateConfig(parsed)
}

export function saveConfig(config: CcrouteConfig): void {
  const dir = configDir()
  ensureDir(dir)

  const path = configPath()
  const tomlContent = serializeToml(config)

  const fd = openSync(path, "w", 0o600)
  try {
    const bytes = new TextEncoder().encode(tomlContent)
    const buffer = new Uint8Array(bytes)
    let written = 0
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written)
    }
  } finally {
    closeSync(fd)
  }

  chmodSync(path, 0o600)
}
