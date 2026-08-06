#!/usr/bin/env bash
set -euo pipefail

REPO="kayacancode/obsidian-gmail-crm"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="peoplegraph"
SKILL_DIR="$HOME/.claude/skills/peoplegraph"

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

# Find the newest peoplegraph-v* release. The repo's `latest` release is the
# Obsidian plugin, which carries no CLI binaries, so filter by tag prefix.
RELEASE_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=100" \
  | grep '"tag_name"' \
  | cut -d '"' -f 4 \
  | grep '^peoplegraph-v' \
  | sort -t v -k 2 -V \
  | tail -1)"

if [ -z "$RELEASE_TAG" ]; then
  echo "Error: no peoplegraph-v* release found in ${REPO}"
  exit 1
fi

echo "Latest CLI release: $RELEASE_TAG"

DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/${RELEASE_TAG}"

echo "Downloading: ${DOWNLOAD_BASE}/${ASSET}"

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download and install
curl -fsSL "${DOWNLOAD_BASE}/${ASSET}" -o "${INSTALL_DIR}/${BINARY_NAME}"
chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

# Ad-hoc codesign on macOS to avoid Gatekeeper kills
if [ "$OS" = "Darwin" ]; then
  echo "Signing binary (ad-hoc) for macOS Gatekeeper..."
  codesign --force --sign - "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null || true
fi

echo ""
echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

# Install the agent skill so coding agents (Claude Code, etc.) know how to use
# the CLI. Shipped as a release asset; falls back to the tagged source tree.
echo "Installing agent skill to ${SKILL_DIR}/SKILL.md"
mkdir -p "$SKILL_DIR"
if ! curl -fsSL "${DOWNLOAD_BASE}/peoplegraph-SKILL.md" -o "${SKILL_DIR}/SKILL.md" 2>/dev/null; then
  if ! curl -fsSL "https://raw.githubusercontent.com/${REPO}/${RELEASE_TAG}/skills/peoplegraph/SKILL.md" -o "${SKILL_DIR}/SKILL.md" 2>/dev/null; then
    echo "Warning: could not fetch the agent skill; skipping (CLI is installed either way)"
    rmdir "$SKILL_DIR" 2>/dev/null || true
  fi
fi

# Check if install dir is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
  echo ""
  echo "NOTE: ${INSTALL_DIR} is not in your PATH. Add it with:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo ""
echo "Run 'peoplegraph --help' to get started."
