import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { FileStore } from "../keychain"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// auth.ts calls createSecretStore() from ../keychain. We mock that factory to
// return a FileStore on a temp dir so tests never touch the real macOS keychain.
let dir: string
let store: FileStore

mock.module("../keychain", () => ({
  createSecretStore: () => store,
  FileStore,
}))

// Import after the mock is registered so auth.ts picks up the mocked factory.
const { getApiKeys, setApiKeys, getApiKey, setApiKey, hasApiKey, clearApiKey, getAuthStatus } = await import("./auth")

describe("opencode auth pool storage", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-opencode-auth-test-"))
    store = new FileStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("getApiKeys returns [] when slot is empty", () => {
    expect(getApiKeys()).toEqual([])
  })

  test("migrates a legacy bare sk- key slot to [key]", () => {
    store.set("ccroute.opencode", "api-key", "sk-abc")
    expect(getApiKeys()).toEqual(["sk-abc"])
  })

  test("does not migrate a legacy bare non-sk slot", () => {
    store.set("ccroute.opencode", "api-key", "not-a-key")
    expect(getApiKeys()).toEqual([])
  })

  test("round-trips a JSON array of keys", () => {
    setApiKeys(["sk-one", "sk-two"])
    expect(getApiKeys()).toEqual(["sk-one", "sk-two"])
  })

  test("setApiKeys trims, drops empties, and dedupes preserving first-seen order", () => {
    setApiKeys(["  sk-one  ", "", "sk-two", "sk-one", "   "])
    expect(getApiKeys()).toEqual(["sk-one", "sk-two"])
  })

  test("setApiKeys rejects a non-sk key", () => {
    expect(() => setApiKeys(["sk-ok", "nope"])).toThrow("API key must start with 'sk-'")
  })

  test("setApiKeys throws on no keys after cleaning", () => {
    expect(() => setApiKeys(["  ", ""])).toThrow("No API keys provided")
    expect(() => setApiKeys([])).toThrow("No API keys provided")
  })

  test("setApiKey wrapper overwrites the pool with a single key", () => {
    setApiKeys(["sk-one", "sk-two"])
    setApiKey("sk-only")
    expect(getApiKeys()).toEqual(["sk-only"])
  })

  test("getApiKey returns first key or null", () => {
    expect(getApiKey()).toBe(null)
    setApiKeys(["sk-first", "sk-second"])
    expect(getApiKey()).toBe("sk-first")
  })

  test("hasApiKey reflects pool state", () => {
    expect(hasApiKey()).toBe(false)
    setApiKeys(["sk-x"])
    expect(hasApiKey()).toBe(true)
  })

  test("clearApiKey removes the whole pool", () => {
    setApiKeys(["sk-a", "sk-b"])
    expect(hasApiKey()).toBe(true)
    clearApiKey()
    expect(hasApiKey()).toBe(false)
    expect(getApiKeys()).toEqual([])
  })

  test("getAuthStatus reports count and previews", () => {
    expect(getAuthStatus()).toEqual({ configured: false, keyCount: 0, keyPreviews: [] })
    setApiKeys(["sk-abcdef123456", "sk-zyxwvu987654"])
    const status = getAuthStatus()
    expect(status.configured).toBe(true)
    expect(status.keyCount).toBe(2)
    expect(status.keyPreviews).toEqual(["sk-abcde...", "sk-zyxwv..."])
  })
})
