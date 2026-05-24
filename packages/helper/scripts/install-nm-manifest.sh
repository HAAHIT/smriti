#!/usr/bin/env bash
# Installs the Native Messaging host manifest for Smriti on macOS and Linux.
#
# Mirrors install-nm-manifest.ps1 (Windows). Registers the helper with
# Chrome, Edge, Brave, and (optionally) Firefox for the current user.
#
# Usage:
#   ./install-nm-manifest.sh <CHROMIUM_EXTENSION_ID> [BRAVE_EXTENSION_ID] [FIREFOX_EXTENSION_ID]
#
# If BRAVE_EXTENSION_ID is omitted, CHROMIUM_EXTENSION_ID is reused.
#
# The Chromium extension ID is the 32-character string shown on
# chrome://extensions or brave://extensions (Developer mode → card).

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <chromium-extension-id> [brave-extension-id] [firefox-extension-id]" >&2
  exit 1
fi

EXTENSION_ID="$1"
BRAVE_EXTENSION_ID="${2:-$EXTENSION_ID}"
FIREFOX_EXTENSION_ID="${3:-}"
HOST_NAME="com.smriti.helper"

# Resolve paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
HELPER_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
DIST_ENTRY="$HELPER_ROOT/dist/index.js"
SRC_ENTRY="$HELPER_ROOT/src/index.ts"

# Wrapper: a small shell script the browser launches. Stdin/stdout become
# the Native Messaging channel. We prefer dist/ if it exists; fall back
# to tsx for dev builds.
WRAPPER_PATH="$HELPER_ROOT/smriti-helper.sh"

if [[ -f "$DIST_ENTRY" ]]; then
  ENTRY="$DIST_ENTRY"
  cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
exec node "$DIST_ENTRY" "\$@"
EOF
else
  ENTRY="$SRC_ENTRY"
  echo "WARNING: dist/index.js not found. Using tsx wrapper (slower start). Run 'npm run build' for production." >&2
  cat > "$WRAPPER_PATH" <<EOF
#!/usr/bin/env bash
exec npx --yes tsx "$SRC_ENTRY" "\$@"
EOF
fi

chmod +x "$WRAPPER_PATH"
echo "wrote wrapper: $WRAPPER_PATH"

# Detect OS and pick the per-browser NM hosts directories.
OS_KIND="$(uname -s)"
case "$OS_KIND" in
  Darwin)
    CHROME_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    EDGE_DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    BRAVE_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    FIREFOX_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    ;;
  Linux)
    CHROME_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    EDGE_DIR="$HOME/.config/microsoft-edge/NativeMessagingHosts"
    BRAVE_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    FIREFOX_DIR="$HOME/.mozilla/native-messaging-hosts"
    ;;
  *)
    echo "ERROR: unsupported OS '$OS_KIND'. Use install-nm-manifest.ps1 on Windows." >&2
    exit 1
    ;;
esac

# Build the chromium manifest. The Brave variant differs only in the
# allowed_origins extension id, so we write two files.
make_chromium_manifest() {
  local ext_id="$1"
  local out="$2"
  cat > "$out" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Smriti helper - local AI conversation archive.",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_origins": [ "chrome-extension://$ext_id/" ]
}
EOF
  echo "wrote manifest: $out"
}

make_firefox_manifest() {
  local ext_id="$1"
  local out="$2"
  cat > "$out" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Smriti helper - local AI conversation archive.",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_extensions": [ "$ext_id" ]
}
EOF
  echo "wrote manifest: $out"
}

register_browser() {
  local label="$1"
  local dir="$2"
  local ext_id="$3"
  local kind="$4" # "chromium" or "firefox"

  if [[ -z "$ext_id" ]]; then
    return
  fi
  mkdir -p "$dir"
  local out="$dir/$HOST_NAME.json"
  if [[ "$kind" == "firefox" ]]; then
    make_firefox_manifest "$ext_id" "$out"
  else
    make_chromium_manifest "$ext_id" "$out"
  fi
  echo "registered $label at $out"
}

register_browser "Chrome" "$CHROME_DIR" "$EXTENSION_ID"       "chromium"
register_browser "Edge"   "$EDGE_DIR"   "$EXTENSION_ID"       "chromium"
register_browser "Brave"  "$BRAVE_DIR"  "$BRAVE_EXTENSION_ID" "chromium"

if [[ -n "$FIREFOX_EXTENSION_ID" ]]; then
  register_browser "Firefox" "$FIREFOX_DIR" "$FIREFOX_EXTENSION_ID" "firefox"
fi

echo
echo "Done. Entry: $ENTRY"
echo "Reload your extension and verify the helper port opens."
