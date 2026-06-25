import { loadConfig } from "./config"
import { info } from "./logger"
import { startServer } from "./server"

export async function cmdServe(args: string[]): Promise<void> {
  let portOverride: number | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      portOverride = parseInt(args[i + 1], 10)
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
  console.log("WARNING: This proxy does not support Anthropic models.")
  console.log("Claude Code will reach Anthropic directly for claude-* models.")
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
  const { generatePkce, buildAuthorizeUrl, startCallbackServer, exchangeCode, saveTokens, hasTokens } = await import("./codex/auth")
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
  console.log("Waiting for callback on http://127.0.0.1:18766/callback ...")
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

export async function cmdOpencodeAuthLogin(_args: string[]): Promise<void> {
  console.log("OpenCode auth login not yet implemented")
  process.exit(1)
}

export async function cmdOpencodeAuthStatus(): Promise<void> {
  try {
    const { getAuthStatus } = await import("./opencode/auth")
    const status = getAuthStatus()
    if (status.configured) {
      console.log("OpenCode auth: ✓ configured")
      if (status.keyPreview) {
        console.log(`  Key: ${status.keyPreview}`)
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
  console.log("OpenCode auth logout not yet implemented")
  process.exit(1)
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
