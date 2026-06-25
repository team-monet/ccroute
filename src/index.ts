#!/usr/bin/env bun
import * as cli from "./cli"
import { error } from "./logger"

function printUsage() {
  console.log(`Usage: ccroute <command> [args]

Commands:
  serve                              Start the proxy server
  models                             Show the routing table
  codex auth login                   Authenticate with ChatGPT (browser)
  codex auth device                  Authenticate with ChatGPT (headless)
  codex auth status                  Show Codex auth state
  codex auth logout                  Clear Codex auth
  opencode auth login                Set OpenCode API key
  opencode auth status               Show OpenCode auth state
  opencode auth logout               Clear OpenCode auth
`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage()
    process.exit(0)
  }
  const [cmd, sub, action, ...rest] = args
  try {
    if (cmd === "serve") return await cli.cmdServe(rest)
    if (cmd === "models") return await cli.cmdModels()
    if (cmd === "codex" && sub === "auth" && action === "login") return await cli.cmdCodexAuthLogin(rest)
    if (cmd === "codex" && sub === "auth" && action === "device") return await cli.cmdCodexAuthDevice(rest)
    if (cmd === "codex" && sub === "auth" && action === "status") return await cli.cmdCodexAuthStatus()
    if (cmd === "codex" && sub === "auth" && action === "logout") return await cli.cmdCodexAuthLogout()
    if (cmd === "opencode" && sub === "auth" && action === "login") return await cli.cmdOpencodeAuthLogin(rest)
    if (cmd === "opencode" && sub === "auth" && action === "status") return await cli.cmdOpencodeAuthStatus()
    if (cmd === "opencode" && sub === "auth" && action === "logout") return await cli.cmdOpencodeAuthLogout()
    printUsage()
    process.exit(1)
  } catch (err) {
    error("command failed", { err: String(err), stack: err instanceof Error ? err.stack : undefined })
    process.exit(1)
  }
}

main()
