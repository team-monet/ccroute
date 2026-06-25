import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, renameSync } from "fs"
import { join } from "path"
import { secretsDir, ensureDir } from "./paths"

export interface SecretStore {
  get(service: string, account: string): string | null
  set(service: string, account: string, value: string): void
  delete(service: string, account: string): boolean
}

function secretFilePath(dir: string, service: string, account: string): string {
  return join(dir, `${service}__${account}.json`)
}

export class FileStore implements SecretStore {
  private dir: string

  constructor(dir?: string) {
    this.dir = dir ?? secretsDir()
  }

  get(service: string, account: string): string | null {
    const file = secretFilePath(this.dir, service, account)
    try {
      const raw = readFileSync(file, "utf-8")
      const parsed = JSON.parse(raw) as { value: string }
      return Buffer.from(parsed.value, "base64").toString("utf-8")
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        return null
      }
      throw e
    }
  }

  set(service: string, account: string, value: string): void {
    ensureDir(this.dir)
    const file = secretFilePath(this.dir, service, account)
    const encoded = Buffer.from(value, "utf-8").toString("base64")
    const payload = JSON.stringify({ value: encoded })
    const tmp = file + ".tmp"
    writeFileSync(tmp, payload, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  }

  delete(service: string, account: string): boolean {
    const file = secretFilePath(this.dir, service, account)
    try {
      unlinkSync(file)
      return true
    } catch (e: unknown) {
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
        return false
      }
      throw e
    }
  }
}

export class KeychainStore implements SecretStore {
  get(service: string, account: string): string | null {
    const proc = Bun.spawnSync([
      "/usr/bin/security",
      "find-generic-password",
      "-s", service,
      "-a", account,
      "-w",
    ])
    if (proc.exitCode === 44) {
      return null
    }
    if (proc.exitCode !== 0) {
      throw new Error(`security find-generic-password failed: exit ${proc.exitCode}`)
    }
    return new TextDecoder().decode(proc.stdout).trimEnd()
  }

  set(service: string, account: string, value: string): void {
    const proc = Bun.spawnSync([
      "/usr/bin/security",
      "add-generic-password",
      "-s", service,
      "-a", account,
      "-w", value,
      "-U",
    ])
    if (proc.exitCode !== 0) {
      throw new Error(`security add-generic-password failed: exit ${proc.exitCode}`)
    }
  }

  delete(service: string, account: string): boolean {
    const proc = Bun.spawnSync([
      "/usr/bin/security",
      "delete-generic-password",
      "-s", service,
      "-a", account,
    ])
    if (proc.exitCode === 44) {
      return false
    }
    if (proc.exitCode !== 0) {
      throw new Error(`security delete-generic-password failed: exit ${proc.exitCode}`)
    }
    return true
  }
}

let cachedStore: SecretStore | null = null

export function createSecretStore(): SecretStore {
  if (cachedStore) return cachedStore
  if (process.platform === "darwin" && existsSync("/usr/bin/security")) {
    cachedStore = new KeychainStore()
  } else {
    cachedStore = new FileStore()
  }
  return cachedStore
}

export function codexTokenStore(): SecretStore {
  return createSecretStore()
}

export function opencodeTokenStore(): SecretStore {
  return createSecretStore()
}
