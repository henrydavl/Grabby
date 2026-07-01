# Grabby

A free, cross-platform video downloader — a personal replacement for IDM (Internet Download
Manager) on macOS (and Windows later). It's a native-feeling Electron app that wraps
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (the engine behind most downloaders, 1000+ sites
including YouTube) plus `ffmpeg`.

## Features (v1)

- **Quality / format picker** — Best, 4K/1440p/1080p/720p/480p, or audio-only (mp3). The picker
  only offers resolutions the video actually has.
- **Download queue with live progress** — percent, speed, ETA; pause / resume / cancel.
- **Playlists & channels** — paste a playlist URL to queue every video.
- **Concurrency limit** — run 1–5 downloads at once (default 3).
- **YouTube cookies** — pick the browser you're signed into so YouTube's bot check passes.
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
- **Deno** (`brew install deno`) — required for YouTube. YouTube's signature / "n" challenges
  now need a JavaScript runtime to solve; yt-dlp uses Deno for this. Without it you get
  *"No video formats found"* / *"Only images are available"*. The app injects `/opt/homebrew/bin`
  into yt-dlp's PATH so it finds Deno even when launched from Finder. *(For a portable build,
  bundle the Deno binary alongside yt-dlp/ffmpeg.)*

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
npm run build:mac    # .dmg
npm run build:win    # .exe (run on / cross-build for Windows)
```

## How it works

- `src/main/` — Electron main process: owns the yt-dlp subprocesses and the download queue.
  - `ytdlp.ts` — locates the bundled `yt-dlp`/`ffmpeg`, builds args, parses progress.
  - `downloadManager.ts` — the queue, concurrency gate, pause/resume/cancel lifecycle.
  - `ipc.ts` + `src/preload/` — a locked-down `contextBridge` API (`window.grabby`); the
    renderer never spawns processes itself.
- `src/renderer/` — React + Tailwind UI (URL bar, format picker, queue rows, settings).
- `resources/bin/<platform>/` — the bundled `yt-dlp` and `ffmpeg` binaries.

## Binaries

The Mac binaries live in `resources/bin/mac/` and are git-ignored (large). Re-fetch with:

```bash
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos \
  -o resources/bin/mac/yt-dlp && chmod +x resources/bin/mac/yt-dlp
cp /opt/homebrew/bin/ffmpeg resources/bin/mac/ffmpeg
```

> ⚠️ The copied Homebrew `ffmpeg` is **dynamically linked** against `/opt/homebrew/lib`, so it
> only runs on Macs that have those libs. For a truly portable `.dmg`, replace it with a
> **static** macOS ffmpeg build (e.g. from evermeet.cx).

## Notes

- **Zen browser users:** Zen is a Firefox fork. Selecting "Firefox" for cookies reads the
  standard Firefox profile path, which may not include Zen's profile. If YouTube still fails,
  point yt-dlp at the Zen profile explicitly (a future setting).
- For personal use — respect each site's Terms of Service and copyright.

## Roadmap

- Clipboard auto-catch (IDM's signature feature)
- Tray / menu-bar mode
- Browser "send to Grabby" extension
- Static ffmpeg bundling + Windows binaries for distributable builds
