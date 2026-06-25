import { createHash } from "crypto"
import { codexTokenStore } from "../keychain"
import { warn } from "../logger"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTH_BASE = "https://auth.openai.com"
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
const REDIRECT_PORT = 1455
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke"
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export interface CodexTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  chatgptAccountId: string
}

export interface PkceChallenge {
  verifier: string
  challenge: string
  state: string
}

function base64urlEncode(data: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i])
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function base64urlDecode(str: string): string {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/")
  const pad = base64.length % 4
  if (pad) base64 += "=".repeat(4 - pad)
  return atob(base64)
}

export function generatePkce(): PkceChallenge {
  const verifierBytes = new Uint8Array(64)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64urlEncode(verifierBytes)

  const hashBuffer = createHash("sha256").update(verifier).digest()
  const challenge = base64urlEncode(new Uint8Array(hashBuffer))

  const stateBytes = new Uint8Array(32)
  crypto.getRandomValues(stateBytes)
  const state = base64urlEncode(stateBytes)

  return { verifier, challenge, state }
}

export function buildAuthorizeUrl(challenge: PkceChallenge, baseUrl?: string): string {
  const base = baseUrl || AUTH_BASE
  const url = new URL("/oauth/authorize", base)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", CLIENT_ID)
  url.searchParams.set("redirect_uri", REDIRECT_URI)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("code_challenge", challenge.challenge)
  url.searchParams.set("scope", SCOPE)
  url.searchParams.set("state", challenge.state)
  url.searchParams.set("originator", "codex_cli")
  url.searchParams.set("id_token_add_organizations", "true")
  url.searchParams.set("codex_cli_simplified_flow", "true")
  return url.toString()
}

function successPage(): string {
  return `<!DOCTYPE html>
<html>
<head><title>Login Complete</title></head>
<body>
<h1>Login complete</h1>
<p>You can close this tab and return to the terminal.</p>
</body>
</html>`
}

function errorPage(reason: string): string {
  const escaped = reason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<!DOCTYPE html>
<html>
<head><title>Login Failed</title></head>
<body>
<h1>Login failed</h1>
<p>${escaped}</p>
</body>
</html>`
}

export function startCallbackServer(expectedState: string): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let server: { stop(): void } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    function cleanup() {
      if (timer) clearTimeout(timer)
      if (server) server.stop()
    }

    try {
      server = Bun.serve({
        port: REDIRECT_PORT,
        hostname: "localhost",
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname !== "/auth/callback") {
            return new Response("Not found", { status: 404 })
          }

          const code = url.searchParams.get("code")
          const state = url.searchParams.get("state")
          const errorParam = url.searchParams.get("error")

          if (errorParam) {
            cleanup()
            reject(new Error(`Authorization failed: ${errorParam}`))
            return new Response(errorPage(`Authorization failed: ${errorParam}`), {
              headers: { "Content-Type": "text/html" },
            })
          }

          if (!code || !state) {
            return new Response(errorPage("Missing code or state parameter"), {
              status: 400,
              headers: { "Content-Type": "text/html" },
            })
          }

          if (state !== expectedState) {
            cleanup()
            reject(new Error("State mismatch — possible CSRF attack"))
            return new Response(errorPage("State mismatch"), {
              headers: { "Content-Type": "text/html" },
            })
          }

          cleanup()
          resolve({ code })
          return new Response(successPage(), {
            headers: { "Content-Type": "text/html" },
          })
        },
      })
    } catch (err) {
      cleanup()
      reject(new Error(`Failed to start callback server on port ${REDIRECT_PORT}: ${err instanceof Error ? err.message : String(err)}`))
      return
    }

    timer = setTimeout(() => {
      cleanup()
      reject(new Error("Login timed out (5 minutes). Please try again."))
    }, 5 * 60 * 1000)
  })
}

function tokenEndpointFor(baseUrl?: string): string {
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/oauth/token` : TOKEN_ENDPOINT
}

function parseTokenResponse(data: Record<string, unknown>): CodexTokens {
  const accessToken = data["access_token"]
  const refreshToken = data["refresh_token"]
  const expiresIn = data["expires_in"]

  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresIn !== "number") {
    throw new Error("Invalid token response: missing access_token, refresh_token, or expires_in")
  }

  const idToken = data["id_token"]
  const jwtToDecode = typeof idToken === "string" ? idToken : accessToken
  const accountId = parseJwtAccountId(jwtToDecode)

  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    chatgptAccountId: accountId,
  }
}

export async function exchangeCode(code: string, verifier: string, baseUrl?: string): Promise<CodexTokens> {
  const endpoint = tokenEndpointFor(baseUrl)
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as Record<string, unknown>
  return parseTokenResponse(data)
}

export async function refreshAccessToken(refreshToken: string, baseUrl?: string): Promise<CodexTokens> {
  const endpoint = tokenEndpointFor(baseUrl)
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`)
  }

  const data = await response.json() as Record<string, unknown>
  return parseTokenResponse(data)
}

export function parseJwtAccountId(jwt: string): string {
  try {
    const parts = jwt.split(".")
    if (parts.length < 2) return "unknown"
    const payloadJson = base64urlDecode(parts[1])
    const payload = JSON.parse(payloadJson) as Record<string, unknown>

    const direct = payload["chatgpt_account_id"]
    if (typeof direct === "string") return direct

    const openaiClaim = payload["https://api.openai.com/auth"]
    if (openaiClaim && typeof openaiClaim === "object") {
      const inner = openaiClaim as Record<string, unknown>
      const innerId = inner["chatgpt_account_id"]
      if (typeof innerId === "string") return innerId
    }

    const orgs = payload["organizations"]
    if (Array.isArray(orgs) && orgs.length > 0) {
      const first = orgs[0]
      if (first && typeof first === "object") {
        const id = (first as Record<string, unknown>)["id"]
        if (typeof id === "string") return id
      }
    }

    return "unknown"
  } catch {
    return "unknown"
  }
}

let inFlight: Promise<CodexTokens> | null = null

export async function getValidToken(): Promise<CodexTokens> {
  const raw = codexTokenStore().get("ccroute.codex", "tokens")
  if (!raw) {
    throw new Error("No Codex tokens found. Run `ccroute codex auth login` to authenticate.")
  }

  let tokens: CodexTokens
  try {
    tokens = JSON.parse(raw) as CodexTokens
  } catch {
    throw new Error("Corrupt token data. Run `ccroute codex auth login` to re-authenticate.")
  }

  if (tokens.expiresAt - Date.now() >= REFRESH_MARGIN_MS) {
    return tokens
  }

  if (inFlight) {
    return inFlight
  }

  inFlight = (async () => {
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken)
      saveTokens(refreshed)
      return refreshed
    } catch (err) {
      clearTokens()
      const msg = err instanceof Error ? err.message : String(err)
      warn(`Token refresh failed: ${msg}`)
      throw new Error(`Token refresh failed. Run \`ccroute codex auth login\` to re-authenticate.`)
    } finally {
      inFlight = null
    }
  })()

  return inFlight
}

export function saveTokens(tokens: CodexTokens): void {
  codexTokenStore().set("ccroute.codex", "tokens", JSON.stringify(tokens))
}

export function clearTokens(): void {
  codexTokenStore().delete("ccroute.codex", "tokens")
}

export function hasTokens(): boolean {
  return codexTokenStore().get("ccroute.codex", "tokens") !== null
}

export function getTokenStatus(): { valid: boolean; expiresAt?: number; accountId?: string } {
  const raw = codexTokenStore().get("ccroute.codex", "tokens")
  if (!raw) return { valid: false }

  try {
    const tokens = JSON.parse(raw) as CodexTokens
    if (!tokens.accessToken || !tokens.refreshToken) return { valid: false }
    return {
      valid: true,
      expiresAt: tokens.expiresAt,
      accountId: tokens.chatgptAccountId,
    }
  } catch {
    return { valid: false }
  }
}
