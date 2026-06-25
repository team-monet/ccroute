# ccroute

Simple dynamic routing proxy for Claude Code CLI.

## Why

You have a Claude Code subscription, ChatGPT Pro web subscription, and OpenCode Go access. You want to route specific subagents to specific backends without setting up a complex proxy infrastructure. ccroute intercepts only the model IDs you direct to it, letting Claude Code reach Anthropic directly for your main conversation while routing subagents to alternative models.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/team-monet/ccroute/main/install.sh | bash
```

The installer downloads the latest release for your platform (macOS/Linux, x64/arm64) to `~/.local/bin/ccroute`. Override with `CCROUTE_INSTALL_DIR=/path`.

For local testing before the first release:

```bash
CCROUTE_LOCAL_BINARY=./ccroute bash install.sh
```

## Quick start

1. Authenticate with your upstreams:
   ```bash
   ccroute codex auth login      # ChatGPT Pro subscription
   ccroute opencode auth login   # OpenCode Go API key
   ```

2. Start the proxy:
   ```bash
   ccroute serve
   ```

3. See the routing table:
   ```bash
   ccroute models
   ```

4. Point Claude Code at the proxy. Add to your shell profile:
   ```bash
   export ANTHROPIC_BASE_URL=http://127.0.0.1:18765
   ```

   **Important:** Do NOT set `ANTHROPIC_BASE_URL` to ccroute if you also want direct Anthropic access for your main conversation. Instead, configure model routing in Claude Code settings to send only specific subagents to ccroute.

## What ccroute does NOT do

ccroute does not proxy Anthropic models — Claude Code reaches Anthropic directly for `claude-*` models. It does not auto-route your main conversation; you set the model in Claude Code settings. ccroute intercepts only the specific model IDs you direct to it via subagent routes or model overrides, or any subagent you explicitly route.

## Configuration

The config file lives at `~/.config/ccroute/config.toml`. On first run, ccroute auto-detects your subagents from `~/.claude/agents/*.md` and populates `[[subagent_routes]]`.

Full default config with comments:

```toml
port = 18765

[codex]
baseUrl = "https://chatgpt.com"
effort = "high"              # low | medium | high
serviceTier = "default"
# allowedModels = ["gpt-4", "o1"]  # optional allowlist for Codex models

[opencode]
baseUrl = "https://opencode.ai/zen/go"

# Subagent routes are auto-populated from ~/.claude/agents/*.md
# Each subagent definition file contains "You are the **<name>**"
# ccroute matches that pattern and routes the subagent to the specified upstream/model

[[subagent_routes]]
match = "You are the **developer**"
upstream = "opencode"
model = "minimax-m3"

[[subagent_routes]]
match = "You are the **explorer**"
upstream = "opencode"
model = "qwen3.7-plus"

# Model-level overrides (applied after subagent detection, before catalog lookup)

[[model_routes]]
match = "my-custom-model"
upstream = "codex"
model = "gpt-4"
```

## Routing

When a request arrives at `/v1/messages`, ccroute resolves the route in this priority order:

1. **Subagent detection** — If the first system block contains a match string from `[[subagent_routes]]`, use that route's upstream and model.
2. **Model routes** — If the model ID matches a `[[model_routes]]` entry, use that override.
3. **Catalog lookup** — If the model ID is in the hardcoded catalog (14 OpenCode models), use that.
4. **Codex pattern** — If the model ID matches `gpt-*`, `o*`, or `codex-*`, route to Codex (subject to `allowedModels` if set).
5. **Anthropic rejection** — If the model ID matches `claude-*`, `*sonnet*`, `*opus*`, or `*haiku*`, return 400 with help text.
6. **Unknown model** — Return 400 with the list of known models.

## Supported models

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

Any model matching `gpt-*`, `o*`, or `codex-*` routes to `/backend-api/codex/responses` via your ChatGPT Pro subscription. Use `codex.allowedModels` in config to restrict which models are permitted.

## CLI reference

```
ccroute serve                              Start the proxy server
ccroute models                             Show the routing table
ccroute codex auth login                   Authenticate with ChatGPT (browser)
ccroute codex auth device                  Authenticate with ChatGPT (headless)
ccroute codex auth status                  Show Codex auth state
ccroute codex auth logout                  Clear Codex auth
ccroute opencode auth login                Set OpenCode API key
ccroute opencode auth status               Show OpenCode auth state
ccroute opencode auth logout               Clear OpenCode auth
```

## Auth storage

On macOS, tokens are stored in Keychain (service `ccroute.codex` for Codex, `ccroute.opencode` for OpenCode). On Linux or if Keychain is unavailable, tokens fall back to `~/.config/ccroute/secrets/` with mode 0600.

## Notes on upstream auth

ccroute authenticates to ChatGPT using the same OAuth `client_id` (`app_EMoamEEZ73f0CkXaXp7hrann`) as the official Codex CLI. This is a first-party client ID extracted from the Codex CLI source; using it from a third-party proxy is a gray area of OpenAI's terms of service — see [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy) for the same approach and a longer discussion. Use at your own risk. If the client ID is revoked, override via the `CCROUTE_CODEX_CLIENT_ID` env var.

ccroute authenticates to OpenCode Go with a Bearer API key that you obtain from [opencode.ai/auth](https://opencode.ai/auth). The key is stored in Keychain/file as described above; it is never logged or sent anywhere other than `opencode.ai`.

## Non-goals (v1)

- No WebSocket or continuation tokens
- No image inputs in tool results (stripped with warning)
- No JSON-schema strict mode
- No tool_use/tool_result translation (text-only at v1)
- No Cursor, Kimi-direct, Bedrock, or Vertex support
- No traffic capture or file logging (stderr only via `CCR_LOG_LEVEL`)
- No multi-account or profile switching
- No self-update command
- No HTTPS on the proxy itself (loopback only)
- No systemd/launchd service management

## Development

```bash
git clone https://github.com/jleechanorg/ccroute.git
cd ccroute
bun install
bun run dev          # watch mode
bun run build        # compile to single binary
bun test src/        # run tests
```

## Credits

Inspired by raine/claude-code-proxy.
