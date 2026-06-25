import { createSecretStore } from "../keychain"

const SERVICE = "ccroute.opencode"
const ACCOUNT = "api-key"

function store() {
  return createSecretStore()
}

export function getApiKey(): string | null {
  return store().get(SERVICE, ACCOUNT)
}

export function setApiKey(key: string): void {
  if (!key || !key.startsWith("sk-")) {
    throw new Error("API key must start with 'sk-'")
  }
  store().set(SERVICE, ACCOUNT, key)
}

export function clearApiKey(): void {
  store().delete(SERVICE, ACCOUNT)
}

export function hasApiKey(): boolean {
  return getApiKey() !== null
}

export function getAuthStatus(): { configured: boolean; keyPreview?: string } {
  const k = getApiKey()
  if (!k) return { configured: false }
  return { configured: true, keyPreview: k.slice(0, 8) + "..." }
}
