#!/usr/bin/env bash
# Assemble loadable extension folders for Chrome and Firefox from the shared src/.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/chrome dist/firefox

cp src/* dist/chrome/
cp manifest.chrome.json dist/chrome/manifest.json

cp src/* dist/firefox/
cp manifest.firefox.json dist/firefox/manifest.json

echo "Built:"
echo "  dist/chrome   → chrome://extensions (Developer mode → Load unpacked)"
echo "  dist/firefox  → about:debugging → This Firefox → Load Temporary Add-on (pick manifest.json)"
