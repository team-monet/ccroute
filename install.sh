#!/usr/bin/env bash
set -euo pipefail

REPO="${CCROUTE_REPO:-team-monet/ccroute}"
INSTALL_DIR="${CCROUTE_INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="ccroute"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR"

if [ -n "${CCROUTE_LOCAL_BINARY:-}" ]; then
  echo "Installing from local binary: $CCROUTE_LOCAL_BINARY"
  cp "$CCROUTE_LOCAL_BINARY" "$INSTALL_DIR/$BINARY_NAME"
else
  URL="https://github.com/$REPO/releases/latest/download/${BINARY_NAME}-${OS}-${ARCH}"
  echo "Downloading $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$INSTALL_DIR/$BINARY_NAME" "$URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$INSTALL_DIR/$BINARY_NAME" "$URL"
  else
    echo "Neither curl nor wget is available" >&2
    exit 1
  fi
fi

chmod +x "$INSTALL_DIR/$BINARY_NAME"

if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "Note: $INSTALL_DIR is not in your PATH."
  echo "Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):"
  echo ""
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo ""
fi

echo "✓ ccroute installed to $INSTALL_DIR/$BINARY_NAME"
"$INSTALL_DIR/$BINARY_NAME" 2>&1 | head -20 || true
