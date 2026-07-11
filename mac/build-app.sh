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

# 2. Info.plist (ATS exception lets the WKWebView load http://localhost)
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
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# 3. Compile the native WKWebView window app (universal: arm64 + x86_64)
echo "  compiling native window (Swift)…"
swiftc -O -whole-module-optimization \
  -target arm64-apple-macos11 \
  "$ROOT/mac/OpenAgent.swift" -o "$APP/Contents/MacOS/OpenAgent.arm64" 2>/dev/null || \
  swiftc -O "$ROOT/mac/OpenAgent.swift" -o "$APP/Contents/MacOS/OpenAgent.arm64"
# try to also build x86_64 for Intel Macs; skip if SDK slice unavailable
if swiftc -O -target x86_64-apple-macos11 "$ROOT/mac/OpenAgent.swift" -o "$APP/Contents/MacOS/OpenAgent.x86_64" 2>/dev/null; then
  lipo -create "$APP/Contents/MacOS/OpenAgent.arm64" "$APP/Contents/MacOS/OpenAgent.x86_64" -output "$APP/Contents/MacOS/OpenAgent"
  rm -f "$APP/Contents/MacOS/OpenAgent.arm64" "$APP/Contents/MacOS/OpenAgent.x86_64"
  echo "  ✓ universal binary (arm64 + x86_64)"
else
  mv "$APP/Contents/MacOS/OpenAgent.arm64" "$APP/Contents/MacOS/OpenAgent"
  echo "  ✓ arm64 binary"
fi
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
