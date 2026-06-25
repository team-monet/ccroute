#!/usr/bin/env bash
#
# ccroute-service.sh — manage ccroute as a background launchd service on macOS.
#
# Usage:
#   ./scripts/ccroute-service.sh install     Generate the LaunchAgent plist and start ccroute in the background
#   ./scripts/ccroute-service.sh uninstall   Stop and remove the service
#   ./scripts/ccroute-service.sh restart      Restart the service (pick up a new binary or config.toml)
#   ./scripts/ccroute-service.sh status       Show whether the service is running + a health check
#   ./scripts/ccroute-service.sh logs         Tail the service log
#
# The service auto-starts at login (RunAtLoad) and restarts if it crashes (KeepAlive).
#
set -euo pipefail

LABEL="com.ccroute.proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ccroute.log"
CONFIG="$HOME/.config/ccroute/config.toml"
DOMAIN="gui/$(id -u)"

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script manages a macOS launchd agent; on Linux use systemd or 'nohup ccroute serve &'."

# Locate the ccroute binary (PATH first, then the default install dir).
find_binary() {
  if command -v ccroute >/dev/null 2>&1; then
    command -v ccroute
  elif [ -x "$HOME/.local/bin/ccroute" ]; then
    echo "$HOME/.local/bin/ccroute"
  else
    die "ccroute binary not found on PATH or in ~/.local/bin. Install it first."
  fi
}

# Read the configured port (default 18765) for the health check.
config_port() {
  if [ -f "$CONFIG" ]; then
    awk -F= '/^[[:space:]]*port[[:space:]]*=/ {gsub(/[^0-9]/,"",$2); print $2; exit}' "$CONFIG"
  fi
}

write_plist() {
  local binary="$1"
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$binary</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- /usr/bin is required: ccroute shells out to 'security' for Keychain access -->
        <key>PATH</key>
        <string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin</string>
    </dict>
</dict>
</plist>
PLIST
}

health_check() {
  local port; port="$(config_port)"; port="${port:-18765}"
  sleep 2
  if curl -fsS --max-time 5 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
    echo "✓ ccroute is responding on port ${port}"
  else
    echo "⚠ service loaded but not responding on port ${port} yet — check logs: $0 logs"
  fi
}

cmd_install() {
  local binary; binary="$(find_binary)"
  echo "binary: $binary"

  # Warn (don't block) if no upstream is authenticated — serve exits without one.
  if ! "$binary" codex auth status 2>/dev/null | grep -q "✓ authenticated" \
     && ! "$binary" opencode auth status 2>/dev/null | grep -q "✓ configured"; then
    echo "⚠ no upstream authenticated yet. Run 'ccroute codex auth login' and/or 'ccroute opencode auth login' first,"
    echo "  otherwise the service will exit immediately and launchd will keep retrying."
  fi

  write_plist "$binary"
  echo "wrote $PLIST"

  # Free the port: stop any manually-running instance and any prior agent (idempotent).
  pkill -f 'ccroute serve' 2>/dev/null || true
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1

  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "loaded service $LABEL"
  health_check
}

cmd_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ removed $LABEL and deleted $PLIST"
}

cmd_restart() {
  [ -f "$PLIST" ] || die "service not installed. Run: $0 install"
  # Self-heal: if launchd dropped the job (e.g. the binary was momentarily
  # absent during an upgrade), kickstart would fail — bootstrap it instead.
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "restarted $LABEL"
  else
    echo "service was not loaded — bootstrapping"
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "loaded $LABEL"
  fi
  health_check
}

cmd_status() {
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E '^[[:space:]]*(state|pid) =' || true
  else
    echo "service $LABEL is not loaded"
  fi
  local port; port="$(config_port)"; port="${port:-18765}"
  curl -fsS --max-time 5 "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1 \
    && echo "✓ responding on port ${port}" \
    || echo "✗ not responding on port ${port}"
}

cmd_logs() {
  [ -f "$LOG" ] || die "no log file at $LOG yet."
  tail -f "$LOG"
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *)
    echo "Usage: $0 {install|uninstall|restart|status|logs}" >&2
    exit 1
    ;;
esac
