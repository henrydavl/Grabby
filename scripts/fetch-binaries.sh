#!/usr/bin/env bash
# Downloads the bundled helper binaries (yt-dlp, ffmpeg, deno) for macOS and
# Windows into resources/bin/. These are gitignored (too large for GitHub), so
# run this once after cloning, before `npm run build`.
set -euo pipefail
cd "$(dirname "$0")/.."

MAC=resources/bin/mac
WIN=resources/bin/win
mkdir -p "$MAC" "$WIN"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

dl() { curl -fL --retry 5 --retry-delay 3 "$1" -o "$2"; }

echo "==> yt-dlp (nightly — YouTube breaks faster than stable)"
dl https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos "$MAC/yt-dlp"
dl https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe "$WIN/yt-dlp.exe"
chmod +x "$MAC/yt-dlp"

echo "==> deno (JS runtime yt-dlp needs to solve YouTube signatures)"
dl https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip "$TMP/deno-mac.zip"
unzip -o -q "$TMP/deno-mac.zip" -d "$MAC"
chmod +x "$MAC/deno"
dl https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip "$TMP/deno-win.zip"
unzip -o -q "$TMP/deno-win.zip" -d "$WIN"

echo "==> ffmpeg"
# Windows: static build from BtbN.
dl https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip "$TMP/ff-win.zip"
unzip -o -j -q "$TMP/ff-win.zip" "*/bin/ffmpeg.exe" -d "$WIN"
# macOS: use the Homebrew build if present (arm64 static builds have no stable URL).
if [ -x /opt/homebrew/bin/ffmpeg ]; then
  cp -L /opt/homebrew/bin/ffmpeg "$MAC/ffmpeg"
  chmod +x "$MAC/ffmpeg"
elif command -v ffmpeg >/dev/null 2>&1; then
  cp -L "$(command -v ffmpeg)" "$MAC/ffmpeg" && chmod +x "$MAC/ffmpeg"
else
  echo "  ! macOS ffmpeg not found — run 'brew install ffmpeg' then re-run this script." >&2
fi

echo "Done. Contents:"
ls -lh "$MAC" "$WIN"
