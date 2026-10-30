#!/usr/bin/env bash
set -euo pipefail

REPO="kayacancode/obsidian-gmail-crm"
VERSION="0.3.13"
INSTALL_DIR="$HOME/.local/bin"
SKILL_DIRS=()
GUIDES=(people-agent-onboarding.md people-memory-integration.md peoplegraph-web-login.md peoplegraph-cli-parity.md)

fail() { echo "Error: $*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Install a versioned PeopleGraph binary and optionally its agent skill.

Usage: bash install-peoplegraph.sh [options]
  --version X.Y.Z       Release version (default: 0.3.13; requires SHA256SUMS)
  --bin-dir PATH        Binary directory (default: ~/.local/bin)
  --skill codex         Install skill in ${CODEX_HOME:-~/.codex}/skills/peoplegraph
  --skill claude        Install skill in ~/.claude/skills/peoplegraph
  --skill agents        Install skill in ~/.agents/skills/peoplegraph
  --skill-dir PATH      Explicit skill directory (the directory containing SKILL.md)
  --help               Show this help

Repeat --skill or --skill-dir to install for multiple agents. With neither option,
only the binary is installed. No agent config, shell profile, or credentials change.
HELP
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--bin-dir|--skill|--skill-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] && [[ "$2" != --* ]] || fail "$1 needs a value"
      case "$1" in
        --version) VERSION="$2" ;;
        --bin-dir) INSTALL_DIR="$2" ;;
        --skill-dir) SKILL_DIRS+=("$2") ;;
        --skill)
          case "$2" in
            codex) SKILL_DIRS+=("${CODEX_HOME:-$HOME/.codex}/skills/peoplegraph") ;;
            claude) SKILL_DIRS+=("$HOME/.claude/skills/peoplegraph") ;;
            agents) SKILL_DIRS+=("$HOME/.agents/skills/peoplegraph") ;;
            *) fail "unknown skill destination '$2'; use codex, claude, agents, or --skill-dir" ;;
          esac
          ;;
      esac
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown option '$1' (see --help)" ;;
  esac
done

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version must have the form X.Y.Z"
command -v curl >/dev/null || fail "curl is required"
if command -v sha256sum >/dev/null; then
  HASH_COMMAND=(sha256sum)
elif command -v shasum >/dev/null; then
  HASH_COMMAND=(shasum -a 256)
else
  fail "sha256sum or shasum is required"
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) ASSET="peoplegraph-macos-arm64" ;;
  Darwin/x86_64) ASSET="peoplegraph-macos-x86_64" ;;
  Linux/x86_64) ASSET="peoplegraph-linux-x86_64" ;;
  *) fail "unsupported platform: $OS $ARCH (supported: macOS arm64/x86_64, Linux x86_64)" ;;
esac

RELEASE_TAG="peoplegraph-v${VERSION}"
DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/${RELEASE_TAG}"
STAGING="$(mktemp -d)"
PENDING_FILE=""
cleanup() {
  rm -rf "$STAGING"
  if [ -n "$PENDING_FILE" ]; then rm -f "$PENDING_FILE"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

download() {
  curl --proto '=https' --tlsv1.2 -fsSL "${DOWNLOAD_BASE}/$1" -o "$STAGING/$1" \
    || fail "could not download $1 from $RELEASE_TAG; existing installation is unchanged"
}
verify() {
  local asset="$1" expected actual
  expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "$STAGING/SHA256SUMS")"
  [[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || fail "missing, malformed, or duplicate checksum for $asset"
  actual="$("${HASH_COMMAND[@]}" "$STAGING/$asset" | awk '{ print $1 }')"
  [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" = "$actual" ] || fail "checksum mismatch for $asset; existing installation is unchanged"
}

# The repository's latest release may be the Obsidian plugin. Use this exact CLI
# tag instead, and finish every download/check before touching installed files.
echo "Downloading $RELEASE_TAG for $OS $ARCH"
download SHA256SUMS
download "$ASSET"
verify "$ASSET"
if [ "${#SKILL_DIRS[@]}" -gt 0 ]; then
  download peoplegraph-SKILL.md
  verify peoplegraph-SKILL.md
  for guide in "${GUIDES[@]}"; do download "$guide"; verify "$guide"; done
fi

# Replacing the inode also avoids overwriting a running/signed macOS binary.
install_file() {
  local source="$1" destination="$2" mode="$3"
  mkdir -p "$(dirname "$destination")"
  PENDING_FILE="$(mktemp "$(dirname "$destination")/.peoplegraph-install.XXXXXX")"
  cp "$source" "$PENDING_FILE"
  chmod "$mode" "$PENDING_FILE"
  if [ "$mode" = "755" ] && [ "$OS" = Darwin ]; then
    codesign --force --sign - "$PENDING_FILE" >/dev/null 2>&1 || fail "macOS ad-hoc signing failed"
  fi
  mv -f "$PENDING_FILE" "$destination"
  PENDING_FILE=""
}

install_file "$STAGING/$ASSET" "$INSTALL_DIR/peoplegraph" 755
echo "Installed $RELEASE_TAG to $INSTALL_DIR/peoplegraph"
# Bash 3.2 treats an empty array as unset under nounset; only expand when nonempty.
if [ "${#SKILL_DIRS[@]}" -gt 0 ]; then
  for skill_dir in "${SKILL_DIRS[@]}"; do
    install_file "$STAGING/peoplegraph-SKILL.md" "$skill_dir/SKILL.md" 644
    for guide in "${GUIDES[@]}"; do
      install_file "$STAGING/$guide" "$skill_dir/references/$guide" 644
    done
    echo "Installed skill and guides to $skill_dir"
  done
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\nAdd the binary directory to your shell PATH if needed:\n  export PATH=%q:"$PATH"\n' "$INSTALL_DIR" ;;
esac
printf '\nCheck: %q version\nNext: peoplegraph login (read-only graph access)\n' "$INSTALL_DIR/peoplegraph"
echo "Private People context uses a separate People key from Accounts → Integrations."
