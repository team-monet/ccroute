import { homedir } from "os"
import { join } from "path"
import { mkdirSync } from "fs"

export function configDir(): string {
  return process.env["CCR_CONFIG_DIR"] || join(homedir(), ".config", "ccroute")
}

export function configPath(): string {
  return join(configDir(), "config.toml")
}

export function codexAuthPath(): string {
  return join(configDir(), "codex", "auth.json")
}

export function opencodeAuthPath(): string {
  return join(configDir(), "opencode", "auth.json")
}

export function secretsDir(): string {
  return join(configDir(), "secrets")
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
}
