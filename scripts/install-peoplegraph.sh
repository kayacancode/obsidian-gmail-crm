#!/usr/bin/env bash
set -euo pipefail

REPO="kayacancode/obsidian-gmail-crm"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="peoplegraph"

# Detect OS and architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)  ASSET="peoplegraph-macos-arm64" ;;
      x86_64) ASSET="peoplegraph-macos-x86_64" ;;
      *)      echo "Error: unsupported macOS architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64) ASSET="peoplegraph-linux-x86_64" ;;
      *)      echo "Error: unsupported Linux architecture: $ARCH"; exit 1 ;;
    esac
    ;;
  *)
    echo "Error: unsupported OS: $OS"
    exit 1
    ;;
esac

echo "Detecting platform: $OS $ARCH -> $ASSET"

# Get latest release download URL
DOWNLOAD_URL="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep "browser_download_url.*${ASSET}" \
  | head -1 \
  | cut -d '"' -f 4)"

if [ -z "$DOWNLOAD_URL" ]; then
  echo "Error: could not find ${ASSET} in latest release"
  exit 1
fi

echo "Downloading from: $DOWNLOAD_URL"

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download and install
curl -fsSL "$DOWNLOAD_URL" -o "${INSTALL_DIR}/${BINARY_NAME}"
chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

# Ad-hoc codesign on macOS to avoid Gatekeeper kills
if [ "$OS" = "Darwin" ]; then
  echo "Signing binary (ad-hoc) for macOS Gatekeeper..."
  codesign --force --sign - "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null || true
fi

echo ""
echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

# Check if install dir is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "NOTE: ${INSTALL_DIR} is not in your PATH. Add it with:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo ""
echo "Run 'peoplegraph --help' to get started."
