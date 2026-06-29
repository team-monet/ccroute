import { createSecretStore } from "../keychain"

const SERVICE = "ccroute.opencode"
const ACCOUNT = "api-key"

function store() {
  return createSecretStore()
}

export function getApiKeys(): string[] {
  const raw = store().get(SERVICE, ACCOUNT)
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON — treat as a legacy bare single key.
    return raw.startsWith("sk-") ? [raw] : []
  }
  if (Array.isArray(parsed)) {
    return parsed.filter((k): k is string => typeof k === "string" && k.startsWith("sk-"))
  }
  // Parsed but not an array — fall back to legacy bare-key migration.
  return raw.startsWith("sk-") ? [raw] : []
}

export function setApiKeys(keys: string[]): void {
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const k of keys) {
    const trimmed = (k ?? "").trim()
    if (!trimmed) continue
    if (!trimmed.startsWith("sk-")) {
      throw new Error("API key must start with 'sk-'")
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    cleaned.push(trimmed)
  }
  if (cleaned.length === 0) {
    throw new Error("No API keys provided")
  }
  store().set(SERVICE, ACCOUNT, JSON.stringify(cleaned))
}

export function getApiKey(): string | null {
  return getApiKeys()[0] ?? null
}

export function setApiKey(key: string): void {
  setApiKeys([key])
}

export function clearApiKey(): void {
  store().delete(SERVICE, ACCOUNT)
}

export function hasApiKey(): boolean {
  return getApiKeys().length > 0
}

export function getAuthStatus(): { configured: boolean; keyCount: number; keyPreviews: string[] } {
  const keys = getApiKeys()
  return {
    configured: keys.length > 0,
    keyCount: keys.length,
    keyPreviews: keys.map((k) => k.slice(0, 8) + "..."),
  }
}
