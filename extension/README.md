# Grabby browser extension

IDM-style browser integration. Pins a **⬇ Grabby** button to the **top-right corner of
each video** on the page (it follows the player as you scroll/resize), plus a toolbar
button — both send the current page URL to the Grabby app, which pops up the quality
picker and downloads it.

It also **sniffs media streams** the page requests — both by URL extension and by
**response `Content-Type`** (`video/*`, HLS/DASH manifests), so it catches extension-less
CDN URLs like Doodstream's. Each stream remembers the frame that requested it, used as its
Referer. The app tries the page URL first (best quality via yt-dlp's site extractors) and
falls back to the sniffed streams. DRM-protected streams (Netflix etc.) still can't be
downloaded.

The content script runs in **all frames** (so the button appears on players embedded via
iframe — StreamTape, Doodstream, etc.) and **pierces open shadow DOM** (Dailymotion and
other web-component players). Cases where the floating button still won't appear: sandboxed
iframes that block scripts, and **closed** shadow roots — for those, use the **toolbar
button**, which always works (it relies on the stream sniffer, not on finding the `<video>`).

> After changing the extension, **reload it** in the browser (Zen/Firefox:
> `about:debugging` → *Reload*; Chrome: the ↻ on the card at `chrome://extensions`),
> then refresh the video page. The new build adds the **webRequest** + **all-sites**
> permissions (needed to observe stream requests) — the browser will ask you to accept
> them on reload.

## How it works

```
[ browser extension ] --POST /add--> [ Grabby app bridge :8787 ] --> format picker
   content.js (floating button)         (127.0.0.1 only, token-checked)
   background.js (toolbar + relay)
```

The app must be **running** — the extension talks to a loopback server Grabby starts
on `http://127.0.0.1:8787`.

## Build & install

```bash
./build.sh        # creates dist/chrome and dist/firefox
```

**Chrome / Brave / Edge:** `chrome://extensions` → enable *Developer mode* →
*Load unpacked* → pick `dist/chrome`.

**Firefox / Zen:** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
pick `dist/firefox/manifest.json`. (Temporary add-ons unload when the browser closes;
for a permanent install the extension needs to be signed by Mozilla / AMO.)

## Notes

- The `grabby-local-bridge` token in `src/background.js` must match `BRIDGE_TOKEN` in the
  app (`src/main/bridge.ts`). It only stops random web pages from POSTing to the local
  server — it isn't a secret.
- The floating button uses the **page URL**, which is what yt-dlp wants for known sites
  (YouTube, Vimeo, etc.). Raw direct-file `<video src>` extraction can be added later.
