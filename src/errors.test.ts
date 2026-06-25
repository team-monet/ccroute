import { describe, test, expect } from "bun:test"
import { redactSecrets } from "./errors"

describe("redactSecrets", () => {
  test("redacts sk- API keys", () => {
    const input = "unauthorized: sk-abcdefghij1234 is invalid"
    const result = redactSecrets(input)
    expect(result).toBe("unauthorized: sk-***REDACTED*** is invalid")
    expect(result).not.toContain("sk-abcdefghij")
  })

  test("redacts Bearer tokens", () => {
    // Use a non-JWT token so the Bearer regex fires (not the JWT regex)
    const input = "auth header: Bearer myOpaqueToken123"
    const result = redactSecrets(input)
    expect(result).toBe("auth header: Bearer ***REDACTED***")
    expect(result).not.toContain("myOpaqueToken123")
  })

  test("redacts Bearer header where token is a JWT (JWT regex fires first)", () => {
    // JWT regex takes priority — the token portion becomes ***REDACTED-JWT***
    // leaving "Bearer " prefix intact but token scrubbed
    const input = "auth header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"
    const result = redactSecrets(input)
    expect(result).toContain("***REDACTED-JWT***")
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
  })

  test("redacts eyJ JWT tokens", () => {
    const input = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    const result = redactSecrets(input)
    expect(result).toBe("token=***REDACTED-JWT***")
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
  })

  test("leaves benign text intact", () => {
    const input = "error code 429: rate limit exceeded, please retry"
    expect(redactSecrets(input)).toBe(input)
  })

  test("leaves short sk- tokens intact (under minimum length)", () => {
    // sk- followed by fewer than 6 chars should not be redacted
    const input = "sk-abc is too short"
    expect(redactSecrets(input)).toBe(input)
  })

  test("redacts multiple secrets in one string", () => {
    const input = "key=sk-validkeyABCDEF jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig auth=Bearer mytoken123"
    const result = redactSecrets(input)
    expect(result).toContain("sk-***REDACTED***")
    expect(result).toContain("***REDACTED-JWT***")
    expect(result).toContain("Bearer ***REDACTED***")
    expect(result).not.toContain("validkeyABCDEF")
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
    expect(result).not.toContain("Bearer mytoken123")
  })
})
