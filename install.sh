#!/bin/bash
# Installs (or reinstalls) TDG Timer into /Applications.
# Usage:  curl -fsSL https://raw.githubusercontent.com/thedesigngroup/tdg-clickup-timer/main/install.sh | bash
set -euo pipefail

REPO="thedesigngroup/tdg-clickup-timer"
APP="/Applications/TDG Timer.app"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading TDG Timer…"
curl -fL --progress-bar "https://github.com/$REPO/releases/latest/download/TDG-Timer-mac.zip" -o "$TMP/app.zip"
ditto -x -k "$TMP/app.zip" "$TMP/out"

# Close the running copy, if any.
osascript -e 'quit app "TDG Timer"' 2>/dev/null || true
sleep 1
pkill -x "TDG Timer" 2>/dev/null || true

rm -rf "$APP"
mv "$TMP/out/TDG Timer.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

open "$APP"
echo "Done. Look for the stopwatch in your menu bar (top right)."
