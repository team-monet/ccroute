import { describe, test, expect } from "bun:test"
import { isUsageLimit, parseRetryAfterSeconds, KeyCooldown } from "./limit"

const LIMIT_BODY = `{"type":"error","error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 32min. ..."},"metadata":{"workspace":"wrk_abc","limitName":"5 hour"}}`

// Real captured 5-hour usage-limit body (live capture 2026-06-29): immediate HTTP 429
// with a GoUsageLimitError body + retry-after header.
const REAL_BODY = `{"type":"error","error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 32min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_X/go"},"metadata":{"workspace":"wrk_X","limitName":"5 hour"}}`

describe("isUsageLimit", () => {
  test("true for 429 with GoUsageLimitError body", () => {
    expect(isUsageLimit(429, LIMIT_BODY)).toBe(true)
  })

  test("true for 429 with the real captured GoUsageLimitError body", () => {
    expect(isUsageLimit(429, REAL_BODY)).toBe(true)
  })

  test("false for 429 with unrelated body", () => {
    expect(isUsageLimit(429, '{"error":{"type":"rate_limit_error"}}')).toBe(false)
  })

  test("false for non-429 status even with GoUsageLimitError body", () => {
    expect(isUsageLimit(400, LIMIT_BODY)).toBe(false)
    expect(isUsageLimit(500, LIMIT_BODY)).toBe(false)
  })

  test("falls back to substring when body is not valid JSON but mentions the error type", () => {
    expect(isUsageLimit(429, "plain text: GoUsageLimitError happened")).toBe(true)
  })

  test("false for 429 with unparseable body that does not mention the error type", () => {
    expect(isUsageLimit(429, "totally unrelated plain text")).toBe(false)
  })
})

describe("parseRetryAfterSeconds", () => {
  test("positive integer header wins", () => {
    expect(parseRetryAfterSeconds("1918", LIMIT_BODY)).toBe(1918)
  })

  test("null header + 'Resets in 32min' body -> 1920", () => {
    expect(parseRetryAfterSeconds(null, LIMIT_BODY)).toBe(1920)
  })

  test("null header + 'Resets in 32 min' (with space) -> 1920", () => {
    expect(parseRetryAfterSeconds(null, "5-hour usage limit reached. Resets in 32 min.")).toBe(1920)
  })

  test("null header + unparseable body -> default 300", () => {
    expect(parseRetryAfterSeconds(null, "something broke")).toBe(300)
  })

  test("null header + 'Resets in 0min' body -> default 300 (do not park for 0ms)", () => {
    expect(parseRetryAfterSeconds(null, "Resets in 0min")).toBe(300)
  })

  test("null header + 'Resets in 0 min' body (with space) -> default 300", () => {
    expect(parseRetryAfterSeconds(null, "Resets in 0 min")).toBe(300)
  })

  test("empty string header falls through to body", () => {
    expect(parseRetryAfterSeconds("", LIMIT_BODY)).toBe(1920)
  })

  test("non-integer header falls through to body", () => {
    expect(parseRetryAfterSeconds("abc", LIMIT_BODY)).toBe(1920)
  })
})

describe("KeyCooldown", () => {
  test("fresh key is available", () => {
    const c = new KeyCooldown()
    expect(c.isAvailable("sk-1", 1000)).toBe(true)
  })

  test("parked key unavailable before reset, available after", () => {
    const c = new KeyCooldown()
    c.park("sk-1", 60, 1000)
    // 1000 + 60*1000 = 61000
    expect(c.isAvailable("sk-1", 60000)).toBe(false)
    expect(c.isAvailable("sk-1", 61000)).toBe(true)
    expect(c.isAvailable("sk-1", 70000)).toBe(true)
  })

  test("unrelated keys are independent", () => {
    const c = new KeyCooldown()
    c.park("sk-1", 60, 1000)
    expect(c.isAvailable("sk-2", 5000)).toBe(true)
  })

  test("soonestResetMs picks the min future cooldown", () => {
    const c = new KeyCooldown()
    c.park("sk-a", 60, 1000)   // available at 61000
    c.park("sk-b", 30, 1000)   // available at 31000
    const keys = ["sk-a", "sk-b", "sk-c"]
    expect(c.soonestResetMs(keys, 5000)).toBe(31000)
  })

  test("soonestResetMs ignores keys that are already available", () => {
    const c = new KeyCooldown()
    c.park("sk-a", 60, 1000)   // 61000
    c.park("sk-b", 30, 1000)   // 31000
    const keys = ["sk-a", "sk-b"]
    // at 31000 sk-b is available, only sk-a is still cooling
    expect(c.soonestResetMs(keys, 31000)).toBe(61000)
  })

  test("soonestResetMs returns null when no keys are cooling", () => {
    const c = new KeyCooldown()
    expect(c.soonestResetMs(["sk-a", "sk-b"], 1000)).toBe(null)
  })

  test("soonestResetMs returns null for keys with no entry", () => {
    const c = new KeyCooldown()
    expect(c.soonestResetMs(["sk-x"], 1000)).toBe(null)
  })
})
