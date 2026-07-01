# Grabby

A free, cross-platform video downloader — a personal replacement for IDM (Internet Download
Manager) on macOS (and Windows later). It's a native-feeling Electron app that wraps
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (the engine behind most downloaders, 1000+ sites
including YouTube) plus `ffmpeg`.

## Download

Prebuilt apps are on the [**Releases**](https://github.com/henrydavl/Grabby/releases/latest) page —
everything (yt-dlp, ffmpeg, deno) is bundled, no separate installs:

- **macOS (Apple Silicon):** `Grabby-0.1.1-arm64.dmg` — unsigned, so **right-click → Open** on first launch.
- **Windows (x64):** `Grabby-0.1.1-win.zip` — portable; unzip anywhere and run `Grabby.exe` (SmartScreen → *More info* → *Run anyway*).
- **Browser extension:** `grabby-extension-chrome.zip` / `grabby-extension-firefox.zip` — see [Install the browser extension](#install-the-browser-extension).

## Features (v1)

- **Quality / format picker** — Best, 4K/1440p/1080p/720p/480p, or audio-only (mp3), each with an
  estimated **file size**. Only offers resolutions the video actually has.
- **Download queue with live progress** — percent, downloaded/total size, speed, ETA;
  pause / resume / cancel; remove from list without deleting the file.
- **Numbered filenames** — re-downloading the same video adds ` (1)`, ` (2)`… instead of overwriting.
- **Browser extension** — IDM-style ⬇ button on videos (incl. embedded iframes) + a toolbar button,
  with network stream sniffing for sites yt-dlp doesn't recognize. See below.
- **Playlists & channels** — paste a playlist URL to queue every video.
- **Concurrency limit** — run 1–5 downloads at once (default 3).
- **YouTube cookies** — pick the browser you're signed into (Chrome/Firefox/**Zen**/Safari/…) so
  YouTube's bot check passes.
- **Update yt-dlp** — one button to self-update when a site breaks.

## Setup (after cloning)

The helper binaries (yt-dlp, ffmpeg, deno) are **not** in git — they're large and platform-specific.
Restore them before running or building:

```bash
./scripts/fetch-binaries.sh   # downloads into resources/bin/{mac,win}
npm install
```

## Requirements

- **Node 22 LTS for development** (Node 25 breaks the Vite dev server). `nvm use 22`.
- The packaged app bundles its own Node via Electron — this only affects dev.
- **Deno** — required for YouTube (its signature / "n" challenges need a JS runtime to solve;
  without it you get *"No video formats found"* / *"Only images are available"*). **It's bundled
  in the release builds** (`resources/bin/<platform>/deno`), and the app prepends that folder to
  the spawned yt-dlp's PATH. When running from source, `scripts/fetch-binaries.sh` downloads it
  (or `brew install deno`).

### Making YouTube work

YouTube actively fights extraction. Three things must line up:

1. **Cookies** — in Settings, pick the browser you're signed into YouTube on. (Zen browser is
   supported and auto-detected.)
2. **Deno** — `brew install deno`.
3. **yt-dlp nightly** — stable lags behind YouTube changes. The "Update yt-dlp" button helps;
   to switch channels: `resources/bin/mac/yt-dlp --update-to nightly`.

## Develop

```bash
nvm use 22
npm install
npm run dev
```

## Build a distributable

```bash
nvm use 22
npm run build        # current platform
npm run build:mac    # .dmg (Apple Silicon)
npm run build:win    # portable Windows .zip (contains Grabby.exe)
```

> A true Windows installer (`.exe` via NSIS) can't be cross-built on macOS without Wine, so the
> Windows target is a **portable zip**. Build the installer on a Windows machine if you need one.
> Also pass `--x64` for Windows (`electron-builder --win --x64`) so it doesn't inherit the Mac's arm64.

## Install the browser extension

The IDM-style extension (a ⬇ button on any video + a toolbar button that send the page to
Grabby) is **not on the Chrome Web Store or Firefox Add-ons** — load it manually. Get
`grabby-extension-chrome.zip` / `grabby-extension-firefox.zip` from the
[latest release](https://github.com/henrydavl/Grabby/releases/latest) and unzip, **or** build
from source:

```bash
cd extension && ./build.sh   # creates extension/dist/chrome and extension/dist/firefox
```

**Chrome / Brave / Edge**
1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** → select the unzipped `chrome` folder

**Firefox / Zen**
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select the `manifest.json` inside the unzipped `firefox` folder

> Firefox/Zen temporary add-ons unload when the browser restarts — reload after each restart
> (a permanent install requires signing the add-on via Mozilla AMO).

Grabby must be **running**: the extension talks to a local bridge on `127.0.0.1:8787`. On a
supported site, hit play, then click the ⬇ button (or the toolbar icon) and Grabby pops up the
quality picker.

## How it works

- `src/main/` — Electron main process: owns the yt-dlp subprocesses and the download queue.
  - `ytdlp.ts` — locates the bundled `yt-dlp`/`ffmpeg`, builds args, parses progress.
  - `downloadManager.ts` — the queue, concurrency gate, pause/resume/cancel lifecycle.
  - `ipc.ts` + `src/preload/` — a locked-down `contextBridge` API (`window.grabby`); the
    renderer never spawns processes itself.
- `src/renderer/` — React + Tailwind UI (URL bar, format picker, queue rows, settings).
- `resources/bin/<platform>/` — the bundled `yt-dlp`, `ffmpeg`, and `deno` binaries.

## Binaries

The `resources/bin/{mac,win}/` binaries are git-ignored (too large for GitHub). Restore them with
one command:

```bash
./scripts/fetch-binaries.sh
```

It downloads yt-dlp (nightly), the official **self-contained** deno, and a **static** ffmpeg for
both platforms (macOS arm64 from martin-riedl.de, Windows x64 from BtbN) — all with zero external
dependencies, so the packaged apps run on machines without Homebrew or anything else installed.

## Notes

- **Zen browser users:** pick **Zen** (not "Firefox") in Settings → cookies. Grabby auto-detects
  the active Zen profile and passes it to yt-dlp.
- **DRM-protected** streams (Netflix, Disney+, etc.) can't be downloaded — they're encrypted.
- For personal use — respect each site's Terms of Service and copyright.

## Roadmap

- [x] **Browser "send to Grabby" extension** — floating ⬇ button (works inside embedded iframes)
  + toolbar button + network stream sniffing for sites yt-dlp doesn't recognize.
- [x] **Fully standalone distributable builds** — yt-dlp, **static** ffmpeg, and **self-contained**
  deno are bundled for both platforms. Verified with zero Homebrew/external deps, so the `.dmg` and
  Windows `.zip` run on a clean machine with nothing else installed.
- [ ] **Clipboard auto-catch** (IDM's signature feature) — *not built yet.* The extension covers
  catching from the browser; clipboard monitoring (detect a copied video URL and offer to grab it)
  is still on the list.
- [ ] Tray / menu-bar mode.
