# ccroute — Implementation Plan (v1)

> Simple dynamic routing proxy for Claude Code CLI.
> Two upstreams at v1: **Codex (ChatGPT Pro web subscription)** and **OpenCode Go**.

## Hard requirements

- **Path**: `/Users/jlee/code/ccroute`
- **Stack**: TypeScript on Bun 1.3.11, single static binary via `bun build --compile`
- **Anthropic is NEVER proxied.** Claude Code reaches Anthropic directly. Proxy rejects `claude-*`/`*sonnet*`/`*opus*`/`*haiku*` with a 400 + help text.
- **Upstream 1 — Codex/ChatGPT**: PKCE OAuth to `https://chatgpt.com/backend-api/codex/responses`. Tokens in macOS Keychain (service `ccroute.codex`) or `~/.config/ccroute/codex/auth.json` (0600) on Linux.
- **Upstream 2 — OpenCode Go**: `https://opencode.ai/zen/go/v1/`. API key in `Authorization: Bearer`. Per-model endpoint shape:
  - **Anthropic shape** (`/v1/messages`, near-passthrough): `minimax-m3`, `minimax-m2.7`, `minimax-m2.5`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`
  - **OpenAI shape** (`/v1/chat/completions`, requires translation): `glm-5.2`, `glm-5.1`, `kimi-k2.7`, `kimi-k2.6`, `deepseek-v4-pro`, `deepseek-v4-flash`, `mimo-v2.5`, `mimo-v2.5-pro`
- **Codex** is a dynamic allowlist: any `gpt-*`, `o*`, or `codex-*` is accepted; optional `codex.allowedModels` allowlist override.
- **Routing priority**: subagent override → `model_routes` override → hardcoded catalog → Codex pattern match → Anthropic reject → unknown.
- **Subagent detection**: substring match on the **first** system block. Default match string `You are the **<name>**` (matches the user's 5 agents: analyst, developer, explorer, reviewer, tester).
- **Endpoints exposed**: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /healthz`, `GET /v1/models`.
- **CLI** (intentionally tiny): `serve`, `codex auth {login,device,status,logout}`, `opencode auth {login,status,logout}`, `models`.
- **Config**: `~/.config/ccroute/config.toml` (Bun has built-in TOML parser).
- **No tests at v1.** Manual smoke tests against real upstreams.

## File tree (18 files)

```
ccroute/
├── package.json
├── tsconfig.json
├── README.md
├── install.sh
├── PLAN.md                          ← this file
├── src/
│   ├── index.ts                     CLI entry
│   ├── cli.ts                       Command handlers
│   ├── config.ts                    TOML load/save/validate/defaults
│   ├── server.ts                    Bun.serve + handlers
│   ├── router.ts                    MODEL_CATALOG, resolveRoute, detectSubagent
│   ├── paths.ts                     XDG dirs
│   ├── logger.ts                    Structured stderr logger
│   ├── errors.ts                    Anthropic-shaped error responses
│   ├── token-counter.ts             gpt-tokenizer o200k_base
│   ├── keychain.ts                  macOS Keychain FFI + file fallback
│   ├── codex/
│   │   ├── auth.ts                  PKCE flow, refresh, JWT decode
│   │   ├── translate.ts             Anthropic ↔ Responses API
│   │   └── reducer.ts               Responses SSE → Anthropic SSE
│   └── opencode/
│       ├── auth.ts                  API key get/set/clear
│       ├── translate.ts             Anthropic ↔ OpenAI chat/completions
│       └── reducer.ts               OpenAI SSE → Anthropic SSE
```

## Module responsibilities (TypeScript signatures)

### `src/index.ts`
```ts
#!/usr/bin/env bun
// Arg parser + dispatch. Side-effect only.
```

### `src/cli.ts`
```ts
export async function cmdServe(args: string[]): Promise<void>
export async function cmdCodexAuthLogin(args: string[]): Promise<void>
export async function cmdCodexAuthDevice(args: string[]): Promise<void>
export async function cmdCodexAuthStatus(): Promise<void>
export async function cmdCodexAuthLogout(): Promise<void>
export async function cmdOpencodeAuthLogin(args: string[]): Promise<void>
export async function cmdOpencodeAuthStatus(): Promise<void>
export async function cmdOpencodeAuthLogout(): Promise<void>
export async function cmdModels(): Promise<void>
```

### `src/config.ts`
```ts
export interface CcrouteConfig {
  port: number                                    // default 18765
  codex: {
    baseUrl: string                               // default "https://chatgpt.com"
    effort: "low" | "medium" | "high"             // default "high"
    serviceTier: string                           // default "default"
    allowedModels?: string[]                      // optional allowlist
  }
  opencode: {
    baseUrl: string                               // default "https://opencode.ai/zen/go/v1"
  }
  subagentRoutes: SubagentRoute[]
  modelRoutes: ModelRouteOverride[]
}

export interface SubagentRoute { match: string; upstream: "codex" | "opencode"; model: string }
export interface ModelRouteOverride { match: string; upstream: "codex" | "opencode"; model: string }

export interface ResolvedRoute {
  upstream: "codex" | "opencode"
  upstreamModelId: string
  endpointPath: "/v1/messages" | "/v1/chat/completions" | "/backend-api/codex/responses"
}

export function loadConfig(): CcrouteConfig
export function saveConfig(config: CcrouteConfig): void
export function defaultConfig(): CcrouteConfig
export function autoDetectSubagentRoutes(): SubagentRoute[]   // scans ~/.claude/agents/*.md
```

### `src/server.ts`
```ts
export function startServer(config: CcrouteConfig): { port: number; stop: () => void }
// POST /v1/messages                → handleMessages
// POST /v1/messages/count_tokens   → handleCountTokens
// GET  /healthz                    → handleHealthz
// GET  /v1/models                  → handleModels

async function handleMessages(req: Request, config: CcrouteConfig): Promise<Response>
async function handleCountTokens(req: Request): Promise<Response>
async function handleHealthz(): Promise<Response>
async function handleModels(config: CcrouteConfig): Promise<Response>
```

### `src/router.ts`
```ts
export const MODEL_CATALOG: ReadonlyMap<string, CatalogEntry>

export interface CatalogEntry {
  upstream: "codex" | "opencode"
  endpointPath: "/v1/messages" | "/v1/chat/completions" | "/backend-api/codex/responses"
  displayName: string
}

export type RouteResult =
  | { kind: "resolved"; route: ResolvedRoute; originalModel: string }
  | { kind: "anthropic-reject"; message: string }
  | { kind: "unknown-model"; message: string }
  | { kind: "not-allowed"; message: string }

export function resolveRoute(modelId: string, systemBlocks: unknown[], config: CcrouteConfig): RouteResult
export function detectSubagent(systemBlocks: unknown[], config: CcrouteConfig): SubagentRoute | null
```

### `src/codex/auth.ts`
```ts
export interface CodexTokens { accessToken: string; refreshToken: string; expiresAt: number; chatgptAccountId: string }
export interface PkceChallenge { verifier: string; challenge: string; state: string }

export function generatePkce(): PkceChallenge
export function buildAuthorizeUrl(challenge: PkceChallenge, baseUrl: string): string
export function startCallbackServer(expectedState: string): Promise<{ code: string }>
export async function exchangeCode(code: string, verifier: string, baseUrl: string): Promise<CodexTokens>
export async function refreshAccessToken(refreshToken: string, baseUrl: string): Promise<CodexTokens>
export function parseJwtAccountId(accessToken: string): string
export async function getValidToken(): Promise<CodexTokens>     // refresh if < 5 min to expiry, single-flight
export function saveTokens(tokens: CodexTokens): void
export function clearTokens(): void
export function hasTokens(): boolean
export function getTokenStatus(): { valid: boolean; expiresAt?: number; accountId?: string }
```

### `src/codex/translate.ts`
```ts
export function anthropicToResponses(body: unknown, model: string): unknown
// system → {role:"developer", content:[{type:"input_text", text}]}
// messages[].role=user/assistant → {role, content:[...]}
// text blocks → {type:"input_text", text}
// tool_use/tool_result → log warning, skip at v1
// max_tokens → max_output_tokens
// stream:true always

export function injectCodexHeaders(headers: Headers, tokens: CodexTokens): void
// Authorization, ChatGPT-Account-Id, Content-Type, Origin, Referer
```

### `src/codex/reducer.ts`
```ts
export function* reduceResponsesStream(
  upstream: AsyncIterable<{ event?: string; data: string }>,
  originalModel: string
): Generator<string, void, void>
// response.created → message_start
// response.output_text.delta → content_block_delta (text_delta)
// response.completed → content_block_stop, message_delta, message_stop
// response.failed → error event + message_stop
```

### `src/opencode/auth.ts`
```ts
export function getApiKey(): string | null
export function setApiKey(key: string): void
export function clearApiKey(): void
export function hasApiKey(): boolean
export function getAuthStatus(): { configured: boolean; keyPreview?: string }
```

### `src/opencode/translate.ts`
```ts
export function anthropicToOpenAI(body: unknown, model: string): unknown
// system blocks → {role:"system", content:string}
// messages → {role, content:string (flattened)}
// tool blocks → log warning, skip at v1
// max_tokens → max_tokens
// stream:true

export function openAIToAnthropicMessage(body: unknown, originalModel: string): unknown
```

### `src/opencode/reducer.ts`
```ts
export function* reduceOpenAIStream(
  upstream: AsyncIterable<{ data: string }>,
  originalModel: string
): Generator<string, void, void>
// first chunk (delta.role=assistant) → message_start + content_block_start (text)
// delta.content → content_block_delta (text_delta)
// final chunk (finish_reason) → content_block_stop, message_delta, message_stop
// finish_reason: "stop"→"end_turn", "length"→"max_tokens", "tool_calls"→"tool_use"
```

### `src/keychain.ts`
```ts
export interface SecretStore {
  get(service: string, account: string): string | null
  set(service: string, account: string, value: string): void
  delete(service: string, account: string): boolean
}
export function createSecretStore(): SecretStore
```

### `src/errors.ts`
```ts
export function anthropicError(status: number, type: string, message: string): Response
export function anthropicStreamError(message: string): string        // SSE event string
export function anthropicModelRejectMessage(modelId: string): string
```

### `src/token-counter.ts`
```ts
export function countTokens(text: string): number
export function countMessagesTokens(messages: unknown[]): number
```

### `src/paths.ts`
```ts
export function configDir(): string            // ~/.config/ccroute
export function configPath(): string           // ~/.config/ccroute/config.toml
export function codexAuthPath(): string        // ~/.config/ccroute/codex/auth.json
export function ensureDir(path: string): void  // mkdir -p, mode 0700
```

### `src/logger.ts`
```ts
export type LogLevel = "debug" | "info" | "warn" | "error"
export function setLogLevel(level: LogLevel): void     // reads CCR_LOG_LEVEL env
export function debug(msg: string, data?: unknown): void
export function info(msg: string, data?: unknown): void
export function warn(msg: string, data?: unknown): void
export function error(msg: string, data?: unknown): void
```

## Hardcoded model catalog (`src/router.ts`)

### OpenCode Go — Anthropic shape (`/v1/messages`)
| Model ID | Display Name |
|---|---|
| `minimax-m3` | MiniMax M3 |
| `minimax-m2.7` | MiniMax M2.7 |
| `minimax-m2.5` | MiniMax M2.5 |
| `qwen3.7-max` | Qwen 3.7 Max |
| `qwen3.7-plus` | Qwen 3.7 Plus |
| `qwen3.6-plus` | Qwen 3.6 Plus |

### OpenCode Go — OpenAI shape (`/v1/chat/completions`)
| Model ID | Display Name |
|---|---|
| `glm-5.2` | GLM 5.2 |
| `glm-5.1` | GLM 5.1 |
| `kimi-k2.7` | Kimi K2.7 |
| `kimi-k2.6` | Kimi K2.6 |
| `deepseek-v4-pro` | DeepSeek V4 Pro |
| `deepseek-v4-flash` | DeepSeek V4 Flash |
| `mimo-v2.5` | MIMO V2.5 |
| `mimo-v2.5-pro` | MIMO V2.5 Pro |

### Codex patterns (dynamic)
- `gpt-*`, `o*`, `codex-*` → `/backend-api/codex/responses`. Optional `codex.allowedModels` allowlist.

### Anthropic rejection
- `claude-*`, `*sonnet*`, `*opus*`, `*haiku*` → 400 with help text.

## Auth flow

### Codex (PKCE)
- Authorize: `GET https://chatgpt.com/api/auth/authorize` with `client_id=app_EMoamEEZ73f0CkXaXp7hrann`, PKCE S256, state, scope `openid profile email`
- Token: `POST https://chatgpt.com/api/auth/token` form-urlencoded, `grant_type=authorization_code` or `refresh_token`
- Callback: temp HTTP server on `127.0.0.1:18766/callback`
- Storage: macOS Keychain service `ccroute.codex` account `tokens`, else `~/.config/ccroute/codex/auth.json` (0600)
- Refresh: if `expiresAt - now < 300s`, single-flight refresh
- 401 → force refresh, retry once
- JWT `chatgpt_account_id` claim → `ChatGPT-Account-Id` header

### OpenCode (API key)
- `ccroute opencode auth login` prompts for key (or `--key` flag)
- Storage: Keychain service `ccroute.opencode` account `api-key`, else `~/.config/ccroute/secrets/opencode.json` (0600)
- `Authorization: Bearer <key>` on every request
- 401/403 → return same status with help text

## Subagent detection (pseudocode)

```ts
function detectSubagent(systemBlocks, config) {
  if (!systemBlocks || systemBlocks.length === 0) return null
  const first = systemBlocks[0]
  let text
  if (typeof first === "string") text = first
  else if (Array.isArray(first)) {
    text = first.filter(b => b?.type === "text").map(b => b.text).join("\n")
  } else return null
  if (!text) return null
  for (const route of config.subagentRoutes) {
    if (!route.match) continue
    if (text.includes(route.match)) return route
  }
  return null
}
```

`autoDetectSubagentRoutes()` scans `~/.claude/agents/*.md` (skipping `.bak`), regex-matches `You are the \*\*(\w+)\*\*`, and emits one `SubagentRoute` per match with `upstream: "opencode"`, `model: "minimax-m3"` as defaults.

## Error mapping

| Upstream | Proxy status | Anthropic error type |
|---|---|---|
| 400 | 400 | `invalid_request_error` |
| 401 | 401 | `authentication_error` |
| 403 | 403 | `permission_error` |
| 404 | 404 | `not_found_error` |
| 429 | 429 | `rate_limit_error` (preserve `retry-after`) |
| 500/502/503 | 502 | `api_error` |
| Timeout | 504 | `timeout_error` |
| Connection refused | 502 | `api_error` |

Mid-stream error: emit `event: error` + `event: message_stop`, then close.

## Subagent-routing on `/v1/messages` flow

1. Parse body JSON; extract `model` field and `system` (string OR array of blocks).
2. `resolveRoute(model, system, config)`:
   - If `detectSubagent` hit → use `subagent.upstream` + `subagent.model`
   - Else if `model_routes` has an exact match → use that
   - Else if `MODEL_CATALOG` has the id → use that
   - Else if matches `/^(gpt-|o\d|codex-)/` and (no allowlist OR in allowlist) → codex
   - Else if matches Anthropic pattern → 400 anthropic-reject
   - Else → 400 unknown-model
3. Dispatch:
   - codex → `getValidToken()` → `anthropicToResponses()` → fetch stream → `reduceResponsesStream()` → SSE Response
   - opencode + Anthropic-shape endpoint → fetch with `Authorization: Bearer` + `anthropic-version` header, near-passthrough (just remap `model` in `message_start` and any other places it surfaces)
   - opencode + OpenAI-shape endpoint → `anthropicToOpenAI()` → fetch stream → `reduceOpenAIStream()` → SSE Response
4. On 401 from codex upstream: force refresh, retry once. On 401 from opencode: 401 to client.

## Non-goals (v1)

1. No WebSocket / continuation tokens.
2. No image inputs in tool results (strip with warning).
3. No JSON-schema strict mode.
4. No tool_use / tool_result translation (text-only at v1).
5. No Cursor, no Kimi-direct, no Bedrock, no Vertex.
6. No traffic capture / file logging (stderr only via `CCR_LOG_LEVEL`).
7. No multi-account / profile switching.
8. No self-update command.
9. No HTTPS on the proxy itself (loopback only).
10. No systemd/launchd service management.

## Implementation order (12 tasks)

```
1  Scaffold project                  ──┐
2  Config + paths                    ──┤
3  CLI entry                         ──┤ foundation (must be sequential)
4  Router + catalog                  ──┤
5  Token counter + /v1/models        ──┘
                                    
6  OpenCode translate + reducer      ──┐
8  Keychain module                   ──┴─→ 7  OpenCode auth + passthrough  (needs 6 + 8)
                                    
9  Codex translate + reducer         ──┐
10 Codex auth (PKCE)                 ──┴─→ 11 Codex upstream wiring  (needs 9 + 10)
                                    
12 Install script + README + build   (needs 7 + 11)
```

Tasks 6+8 and 9+10 can run in parallel. Task 7 and 11 are integration points.

## Build & release

```bash
bun run build              # bun build src/index.ts --compile --outfile=ccroute
bun run build:all          # cross-compile darwin-{arm64,x64} + linux-{arm64,x64}
```

Install: `curl -fsSL https://raw.githubusercontent.com/<user>/ccroute/main/install.sh | bash` → `~/.local/bin/ccroute`.

## Open questions for the user

1. Real ChatGPT Pro account for testing tasks 10-11?
2. Real OpenCode Go API key for testing task 7?
3. Should unknown models have a configurable `defaultUpstream` fallback, or always 400?
4. GitHub org/user for the repo (matters for install.sh in task 12)?
