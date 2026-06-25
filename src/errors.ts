export function anthropicError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "content-type": "application/json" } }
  )
}

export function anthropicStreamError(message: string): string {
  const err = JSON.stringify({ type: "error", error: { type: "api_error", message } })
  return `event: error\ndata: ${err}\n\nevent: message_stop\ndata: {}\n\n`
}

export function anthropicModelRejectMessage(modelId: string): string {
  return (
    `Model '${modelId}' is an Anthropic model and should not be routed through ccroute. ` +
    `Claude Code connects to Anthropic directly via your subscription. ` +
    `Do not set ANTHROPIC_BASE_URL to point at ccroute.`
  )
}
