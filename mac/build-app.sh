#!/bin/bash
# Builds OpenAgent.app — a double-clickable macOS app that launches the
# full local agent (terminal + files + local Ollama models) and opens the browser.
#
# Usage:  ./mac/build-app.sh        (run from the repo root)
# Output: dist/OpenAgent.app  and  dist/OpenAgent-mac.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/OpenAgent.app"
VERSION="${1:-1.0.0}"

echo "Building OpenAgent.app v$VERSION…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1. Bundle the server
cp "$ROOT/openrouter-agent.js" "$APP/Contents/Resources/openrouter-agent.js"

# 2. Info.plist
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>OpenAgent</string>
  <key>CFBundleDisplayName</key><string>Open·Agent</string>
  <key>CFBundleIdentifier</key><string>io.github.micorlov.openagent</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>OpenAgent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# 3. Launcher executable — finds node, starts the server, opens the browser
cat > "$APP/Contents/MacOS/OpenAgent" <<'LAUNCH'
#!/bin/bash
# Locate the app's Resources dir
HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
SERVER="$HERE/openrouter-agent.js"
PORT=3001
URL="http://localhost:$PORT/"

# GUI-launched apps have a minimal PATH — search common node locations
NODE=""
for c in "$(command -v node 2>/dev/null)" \
         /opt/homebrew/bin/node /usr/local/bin/node \
         "$HOME/.nvm/versions/node"/*/bin/node \
         "$HOME/.volta/bin/node" /usr/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done

if [ -z "$NODE" ]; then
  osascript -e 'display dialog "Node.js is required to run Open·Agent.\n\nInstall it from nodejs.org (or: brew install node), then reopen this app." buttons {"Get Node.js", "Cancel"} default button "Get Node.js" with title "Open·Agent"' \
    -e 'if button returned of result is "Get Node.js" then open location "https://nodejs.org/en/download"' >/dev/null 2>&1 || true
  exit 1
fi

# If a server is already running on the port, just open the browser
if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
  open "$URL"; exit 0
fi

# Open the browser once the server answers
( for i in $(seq 1 40); do
    curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null && { open "$URL"; break; }
    sleep 0.5
  done ) &

# Run the server in the foreground so quitting the app stops it
exec "$NODE" "$SERVER"
LAUNCH
chmod +x "$APP/Contents/MacOS/OpenAgent"

# 4. Icon (optional — only if a prebuilt icon.icns exists)
if [ -f "$ROOT/mac/icon.icns" ]; then
  cp "$ROOT/mac/icon.icns" "$APP/Contents/Resources/icon.icns"
fi

# 5. Ad-hoc codesign so Gatekeeper is less hostile (still needs right-click→Open first time)
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "  (codesign skipped)"

# 6. Zip for distribution
( cd "$ROOT/dist" && rm -f OpenAgent-mac.zip && ditto -c -k --keepParent OpenAgent.app OpenAgent-mac.zip )

echo "✓ Built: $APP"
echo "✓ Zipped: $ROOT/dist/OpenAgent-mac.zip"
