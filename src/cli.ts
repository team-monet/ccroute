import { loadConfig } from "./config"
import { info } from "./logger"
import { startServer } from "./server"

export async function cmdServe(args: string[]): Promise<void> {
  let portOverride: number | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      const parsed = parseInt(args[i + 1], 10)
      if (Number.isNaN(parsed) || parsed <= 0) {
        process.stderr.write("error: --port must be a positive integer\n")
        process.exit(1)
      }
      portOverride = parsed
      i++
    }
  }

  const config = loadConfig()
  if (portOverride !== undefined) {
    config.port = portOverride
  }

  let codexAuth = false
  let opencodeAuth = false
  try {
    const codexAuthModule = await import("./codex/auth")
    codexAuth = codexAuthModule.hasTokens()
  } catch {}
  try {
    const opencodeAuthModule = await import("./opencode/auth")
    opencodeAuth = opencodeAuthModule.hasApiKey()
  } catch {}

  if (!codexAuth && !opencodeAuth) {
    console.log("No upstream authentication configured.")
    console.log("Run one of:")
    console.log("  ccroute codex auth login      (ChatGPT Pro subscription)")
    console.log("  ccroute opencode auth login    (OpenCode Go API key)")
    process.exit(1)
  }

  const { listAdvertisedModels } = await import("./router")
  const models = listAdvertisedModels(config)
  const modelsLength = models.length

  if (modelsLength > 0) {
    console.log(`Routing table: ${modelsLength} models available`)
  }
  console.log(`Subagent routes: ${config.subagentRoutes.length}`)
  console.log("")
  console.log(`Set your Claude Code proxy:`)
  console.log(`  export ANTHROPIC_BASE_URL=http://127.0.0.1:${config.port}`)
  console.log("")
  console.log("claude-* requests pass through to " + config.anthropic.baseUrl + " (set [anthropic] passthrough=false to disable).")
  if (config.anthropic.passthrough && config.anthropic.baseUrl !== "https://api.anthropic.com") {
    console.log(`WARNING: anthropic.baseUrl is ${config.anthropic.baseUrl} — your Anthropic credentials will be forwarded there, not to api.anthropic.com.`)
  }
  console.log("")

  const server = startServer(config)
  info(`ccroute listening on port ${server.port}`)

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      info("received SIGINT, shutting down")
      server.stop()
      resolve()
    })
  })
}

export async function cmdCodexAuthLogin(_args: string[]): Promise<void> {
  const { generatePkce, buildAuthorizeUrl, startCallbackServer, exchangeCode, saveTokens, hasTokens, REDIRECT_URI } = await import("./codex/auth")
  if (hasTokens()) {
    console.log("Existing Codex auth found. Re-authenticating will overwrite.")
  }
  const pkce = generatePkce()
  const url = buildAuthorizeUrl(pkce)
  console.log("Opening browser to:")
  console.log("  " + url)
  console.log("")
  console.log("If the browser does not open, paste the URL above into your browser.")
  const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null
  if (opener) {
    try {
      Bun.spawnSync([opener, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    } catch { /* ignore */ }
  }
  console.log(`Waiting for callback on ${REDIRECT_URI} ...`)
  const { code } = await startCallbackServer(pkce.state)
  console.log("Exchanging code for tokens...")
  const tokens = await exchangeCode(code, pkce.verifier)
  saveTokens(tokens)
  console.log("✓ Authenticated!")
  console.log("  Account: " + tokens.chatgptAccountId)
  console.log("  Expires: " + new Date(tokens.expiresAt).toISOString())
  console.log("  Tokens stored securely.")
}

export async function cmdCodexAuthDevice(args: string[]): Promise<void> {
  return cmdCodexAuthLogin(args)
}

export async function cmdCodexAuthStatus(): Promise<void> {
  try {
    const { getTokenStatus } = await import("./codex/auth")
    const status = getTokenStatus()
    if (status.valid) {
      console.log("Codex auth: ✓ authenticated")
      if (status.expiresAt) {
        const expires = new Date(status.expiresAt)
        console.log(`  Expires: ${expires.toISOString()}`)
      }
      if (status.accountId) {
        console.log(`  Account: ${status.accountId}`)
      }
    } else {
      console.log("Codex auth: ✗ not authenticated")
      console.log("Run: ccroute codex auth login")
    }
  } catch {
    console.log("Codex auth not yet implemented (Task 10)")
    process.exit(1)
  }
}

export async function cmdCodexAuthLogout(): Promise<void> {
  const { clearTokens } = await import("./codex/auth")
  clearTokens()
  console.log("✓ Codex auth tokens cleared.")
}

export async function cmdOpencodeAuthLogin(args: string[]): Promise<void> {
  const fromArg = args.some((a) => a && a.trim())
  let keys: string[]
  if (fromArg) {
    keys = args.map((a) => (a ?? "").trim()).filter(Boolean)
  } else {
    keys = []
    for (;;) {
      const entered = prompt("Enter an OpenCode Go API key (sk-...), blank line to finish:")
      const trimmed = entered ? entered.trim() : ""
      if (!trimmed) break
      keys.push(trimmed)
    }
  }
  if (keys.length === 0) {
    console.log("No API key provided.")
    process.exit(1)
  }
  try {
    const { setApiKeys, getApiKeys } = await import("./opencode/auth")
    const existing = getApiKeys()
    if (existing.length > 0) process.stderr.write(`note: replacing ${existing.length} existing key(s).\n`)
    setApiKeys(keys)
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
  if (fromArg) {
    process.stderr.write("note: passing keys as arguments leaves them in your shell history; prefer the interactive prompt next time.\n")
  }
  console.log(`✓ Stored ${keys.length} OpenCode API key(s).`)
}

export async function cmdOpencodeAuthStatus(): Promise<void> {
  try {
    const { getAuthStatus } = await import("./opencode/auth")
    const status = getAuthStatus()
    if (status.configured) {
      console.log("OpenCode auth: ✓ configured")
      console.log(`  Keys (${status.keyCount}):`)
      for (const preview of status.keyPreviews) {
        console.log(`  - ${preview}`)
      }
    } else {
      console.log("OpenCode auth: ✗ not configured")
      console.log("Run: ccroute opencode auth login")
    }
  } catch {
    console.log("OpenCode auth not yet implemented")
    process.exit(1)
  }
}

export async function cmdOpencodeAuthLogout(): Promise<void> {
  const { clearApiKey } = await import("./opencode/auth")
  clearApiKey()
  console.log("✓ OpenCode API key cleared.")
}

export async function cmdModels(): Promise<void> {
  const config = loadConfig()
  const { listAdvertisedModels } = await import("./router")
  const models = listAdvertisedModels(config)
  console.log("Routing table:")
  console.log("")
  for (const m of models) {
    console.log(`  ${m.id.padEnd(25)} ${m.upstream.padEnd(10)} ${m.displayName}`)
  }
}
