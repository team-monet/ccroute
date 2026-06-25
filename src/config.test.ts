import { describe, test, expect } from "bun:test"

// validateConfig is not exported directly, but we can test it via the
// exported loadConfig path indirectly. Instead, we replicate the logic
// by calling the module's internal validateConfig via a config object
// that would come from TOML.parse. Since validateConfig is unexported,
// we test it through a thin wrapper: pass raw config-shaped objects
// to the function chain by importing and calling deepMerge + validate
// indirectly. The simplest approach is to use the TOML module to
// create a config and then call loadConfig with a temp file — but that
// requires filesystem. Instead, we extract validateConfig by re-exporting
// it temporarily, OR we test via the real module's public surface.
//
// The cleanest approach given the codebase structure: call loadConfig
// with a temp config file that has the relevant field values.
// We use Bun's test infrastructure to mock the fs, OR we just inline
// the logic under test directly in a minimal test helper.
//
// Since validateConfig is internal to config.ts, we test it by calling
// it indirectly via a mock TOML file. We write a temp file, set
// HOME to a temp dir, and call loadConfig. However, that mutates HOME.
//
// Simplest correct approach: factor out the URL validation logic into
// a separate function and export it, but since we cannot change the
// spec, we instead test by directly importing config.ts and relying on
// the fact that validateConfig throws synchronously before any FS side
// effects if the config object is malformed.
//
// We can call validateConfig by re-creating the logic here in a
// unit-testable way — but that's duplicating. The pragmatic approach
// for this codebase: we call the TOML.parse -> validateConfig path by
// temporarily writing a config file. But to avoid coupling to FS state
// we instead expose a testable function. Since we should not change
// the module API, we resort to using dynamic import with a test helper.
//
// Actual approach chosen: write a minimal shim that calls into
// validateConfig by building a raw object and hitting the code path
// via TOML.parse of a string, then feeding that into a cloned
// validateConfig. We CANNOT do that without changing the export.
//
// Conclusion: The least-invasive correct solution is to export
// validateConfig from config.ts for testing. We do that here by
// importing a test-only re-export. Given the spec says "Add a config
// test: validateConfig throws for ...", we will export validateConfig.

// NOTE: We export validateConfig for test access (see implementation note
// in config.ts — the function is exported).
import { validateConfigForTest } from "./config"

describe("validateConfig - anthropic.baseUrl scheme validation", () => {
  function makeRaw(baseUrl: unknown): Record<string, unknown> {
    return {
      port: 18765,
      anthropic: { baseUrl },
    }
  }

  test("accepts https://api.anthropic.com", () => {
    expect(() => validateConfigForTest(makeRaw("https://api.anthropic.com"))).not.toThrow()
  })

  test("accepts http://127.0.0.1:9000 (loopback)", () => {
    expect(() => validateConfigForTest(makeRaw("http://127.0.0.1:9000"))).not.toThrow()
  })

  test("accepts http://localhost:8080 (loopback)", () => {
    expect(() => validateConfigForTest(makeRaw("http://localhost:8080"))).not.toThrow()
  })

  test("accepts http://[::1]:8080 (loopback IPv6)", () => {
    expect(() => validateConfigForTest(makeRaw("http://[::1]:8080"))).not.toThrow()
  })

  test("rejects http://evil.com (non-loopback http)", () => {
    expect(() => validateConfigForTest(makeRaw("http://evil.com"))).toThrow(
      /refusing to forward Anthropic credentials/
    )
  })

  test("rejects http://192.168.1.1 (non-loopback private IP)", () => {
    expect(() => validateConfigForTest(makeRaw("http://192.168.1.1"))).toThrow(
      /refusing to forward Anthropic credentials/
    )
  })

  test("rejects ftp://api.anthropic.com (wrong scheme)", () => {
    expect(() => validateConfigForTest(makeRaw("ftp://api.anthropic.com"))).toThrow(
      /refusing to forward Anthropic credentials/
    )
  })

  test("rejects an unparseable URL", () => {
    expect(() => validateConfigForTest(makeRaw("not-a-url"))).toThrow(
      /must be a valid URL/
    )
  })

  test("rejects empty string", () => {
    expect(() => validateConfigForTest(makeRaw(""))).toThrow(
      /must be a non-empty string/
    )
  })
})
