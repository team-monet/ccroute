// OpenCode (opencode.ai/zen/go) enforces a per-workspace 5-hour usage limit. When
// a key's workspace is tapped out, BOTH endpoints return HTTP 429 with header
// `retry-after: <seconds>` and a JSON body whose error.type is "GoUsageLimitError"
// (content-type is text/plain, so we must NOT rely on content-type — parse the body).
//
// Rotation triggers ONLY on a PRE-STREAM HTTP 429 usage-limit. OpenCode was confirmed
// (live capture 2026-06-29) to return the 5-hour limit as an immediate 429 with a
// GoUsageLimitError body + retry-after header, NOT as a mid-stream SSE error, so
// mid-stream limits are intentionally out of scope.

export function isUsageLimit(status: number, body: string): boolean {
  if (status !== 429) return false
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown } }
    return parsed?.error?.type === "GoUsageLimitError"
  } catch {
    return body.includes("GoUsageLimitError")
  }
}

export function parseRetryAfterSeconds(headerValue: string | null, body: string): number {
  if (headerValue != null) {
    const n = Number(headerValue.trim())
    if (Number.isInteger(n) && n > 0) return n
  }
  // Body carries "Resets in 32min." / "Resets in 32 min." — extract minutes.
  const m = body.match(/Resets in\s+(\d+)\s*min/i)
  if (m) {
    const minutes = Number(m[1])
    if (Number.isFinite(minutes) && minutes > 0) return Math.round(minutes * 60)
  }
  return 300
}

export class KeyCooldown {
  private cooldowns = new Map<string, number>()

  isAvailable(key: string, now: number = Date.now()): boolean {
    const until = this.cooldowns.get(key)
    if (until === undefined) return true
    return until <= now
  }

  park(key: string, retryAfterSeconds: number, now: number = Date.now()): void {
    this.cooldowns.set(key, now + retryAfterSeconds * 1000)
  }

  soonestResetMs(keys: string[], now: number = Date.now()): number | null {
    let soonest: number | null = null
    for (const k of keys) {
      const until = this.cooldowns.get(k)
      if (until === undefined) continue
      if (until <= now) continue // already available — not cooling
      if (soonest === null || until < soonest) soonest = until
    }
    return soonest
  }
}
