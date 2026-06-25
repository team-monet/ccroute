import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { FileStore, createSecretStore, type SecretStore } from "./keychain"
import { mkdtempSync, rmSync, statSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("FileStore", () => {
  let dir: string
  let store: FileStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-keychain-test-"))
    store = new FileStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("get returns null for missing entry", () => {
    expect(store.get("svc", "acct")).toBeNull()
  })

  test("set then get round-trips", () => {
    store.set("svc", "acct", "s3cret")
    expect(store.get("svc", "acct")).toBe("s3cret")
  })

  test("set overwrites existing value", () => {
    store.set("svc", "acct", "first")
    store.set("svc", "acct", "second")
    expect(store.get("svc", "acct")).toBe("second")
  })

  test("delete returns true when entry existed", () => {
    store.set("svc", "acct", "val")
    expect(store.delete("svc", "acct")).toBe(true)
  })

  test("delete returns false when entry did not exist", () => {
    expect(store.delete("svc", "acct")).toBe(false)
  })

  test("get returns null after delete", () => {
    store.set("svc", "acct", "val")
    store.delete("svc", "acct")
    expect(store.get("svc", "acct")).toBeNull()
  })

  test("file mode is 0600", () => {
    store.set("svc", "acct", "val")
    const file = join(dir, "svc__acct.json")
    expect(existsSync(file)).toBe(true)
    const st = statSync(file)
    expect(st.mode & 0o777).toBe(0o600)
  })

  test("directory mode is 0700", () => {
    const nested = join(dir, "subdir")
    const nestedStore = new FileStore(nested)
    nestedStore.set("svc", "acct", "val")
    const st = statSync(nested)
    expect(st.mode & 0o777).toBe(0o700)
  })

  test("handles values with special characters", () => {
    const val = 'line1\nline2\t"quotes"\\backslash\u0000null'
    store.set("svc", "acct", val)
    expect(store.get("svc", "acct")).toBe(val)
  })

  test("different service/account pairs are independent", () => {
    store.set("svc1", "acct1", "val1")
    store.set("svc2", "acct2", "val2")
    expect(store.get("svc1", "acct1")).toBe("val1")
    expect(store.get("svc2", "acct2")).toBe("val2")
    store.delete("svc1", "acct1")
    expect(store.get("svc1", "acct1")).toBeNull()
    expect(store.get("svc2", "acct2")).toBe("val2")
  })
})

describe("createSecretStore", () => {
  test("returns an object with get, set, delete methods", () => {
    const store: SecretStore = createSecretStore()
    expect(typeof store.get).toBe("function")
    expect(typeof store.set).toBe("function")
    expect(typeof store.delete).toBe("function")
  })
})
