#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
APP_NAME="${APP_NAME:-MediaAnalyzerSidecar}"
APP_DIR="${APP_DIR:-$HOME/Applications/$APP_NAME.app}"
LOG_FILE="${LOG_FILE:-/tmp/media-analyzer-sidecar.log}"
RUNTIME_DIR="${RUNTIME_DIR:-$HOME/Library/Application Support/MediaAnalyzerSidecar/runtime}"
SIDECAR_ENTRY="$RUNTIME_DIR/tools/rtmp-sidecar/server.mjs"
TMP_SCRIPT="$(mktemp -t media-analyzer-sidecar.XXXXXX.applescript)"

cleanup() {
  rm -f "$TMP_SCRIPT"
}
trap cleanup EXIT

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node executable not found. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

mkdir -p "$(dirname "$APP_DIR")"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/tools" "$RUNTIME_DIR/lib/codec"
cp -R "$REPO_ROOT/tools/rtmp-sidecar" "$RUNTIME_DIR/tools/"
cp "$REPO_ROOT/lib/codec/flvTagWriter.js" "$RUNTIME_DIR/lib/codec/"

cat > "$TMP_SCRIPT" <<EOF
on open location this_URL
    do shell script "cd /tmp && " & quoted form of "$NODE_BIN" & " " & quoted form of "$SIDECAR_ENTRY" & " " & quoted form of this_URL & " >> " & quoted form of "$LOG_FILE" & " 2>&1 &"
end open location

on run
    set this_APP to POSIX path of (path to me)
    do shell script quoted form of "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" & " -f " & quoted form of this_APP
    display notification "media-analyzer:// registered" with title "Media Analyzer Sidecar"
end run
EOF

rm -rf "$APP_DIR"
osacompile -o "$APP_DIR" "$TMP_SCRIPT"

PLIST="$APP_DIR/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.media-analyzer.sidecar" "$PLIST" 2>/dev/null || \
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.media-analyzer.sidecar" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string Media Analyzer Sidecar URL" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string media-analyzer" "$PLIST"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
"$LSREGISTER" -f "$APP_DIR"

echo "Registered media-analyzer:// with $APP_DIR"
echo "Installed sidecar runtime: $RUNTIME_DIR"
echo "Sidecar log: $LOG_FILE"
echo "Test:"
echo "  open 'media-analyzer://open?rtmp=rtmp%3A%2F%2Fhost%2Flive%2Fstream'"
