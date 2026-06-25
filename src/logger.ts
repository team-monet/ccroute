export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

let currentLevel: LogLevel = ((process.env["CCR_LOG_LEVEL"] as LogLevel) || "info")
let currentThreshold = LEVELS[currentLevel] ?? LEVELS.info

export function setLogLevel(level: LogLevel): void {
  currentLevel = level
  currentThreshold = LEVELS[level]
}

function log(level: LogLevel, msg: string, data?: unknown): void {
  if (LEVELS[level] < currentThreshold) return
  const ts = new Date().toISOString()
  const suffix = data !== undefined ? " " + JSON.stringify(data) : ""
  process.stderr.write(`${ts} [${level.toUpperCase()}] ${msg}${suffix}\n`)
}

export function debug(msg: string, data?: unknown): void {
  log("debug", msg, data)
}

export function info(msg: string, data?: unknown): void {
  log("info", msg, data)
}

export function warn(msg: string, data?: unknown): void {
  log("warn", msg, data)
}

export function error(msg: string, data?: unknown): void {
  log("error", msg, data)
}
