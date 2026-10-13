# Download engine rework — research & plan

Status: draft for discussion (2026-10-13)

## Goals

1. The extension catches **any embedded video** that plays in the browser (except DRM; IDM can't do DRM either), not only sites yt-dlp has an extractor for.
2. A download engine that **retries and resumes** after network trouble instead of failing.
3. Speeds at least as fast as FDM/IDM on the same network, using ideas from how they work.

## How Grabby works today

```
extension ──(page URL + sniffed URLs)──▶ bridge ──▶ renderer tries each candidate with `yt-dlp -J`
                                                          │
                                                          ▼
                                    DownloadManager ──spawn──▶ yt-dlp (downloads + merges via ffmpeg)
```

- yt-dlp does **both** jobs: finding the media URL and downloading it.
- One process per download. Pause = `SIGTERM`. Any non-zero exit becomes `status: 'error'`, and Grabby never retries on its own.
- yt-dlp runs with its defaults: 10 retries, 10 fragment retries, **1 HLS/DASH fragment at a time (`-N 1`)**, and **one connection** for a progressive file.
- The extension identifies streams **only by URL extension or `Content-Type`** and sends only the URL plus a Referer. No cookies, Origin, User-Agent or auth headers are sent.

## Measurements (this Mac, bundled yt-dlp 2026.06.29)

| Test | Result |
|---|---|
| Raw bandwidth, single curl connection (proof.ovh.net) | ~4.0 MB/s |
| YouTube 4K AV1 (fmt 401) via yt-dlp, as Grabby runs it | ~61 MB in the ~12 s after ~8 s of extraction → **~5 MB/s** |
| HLS test stream (mux.dev), `-N 1` + `generic:impersonate` | **5.8 MB/s** |
| Same, `-N 8` | 5.7 MB/s |
| YouTube direct URL, plain GET without range | 0 bytes (googlevideo refuses it) |

**Conclusion:** on a fast CDN, neither yt-dlp nor the impersonation flag is the bottleneck. The ~500 KB/s cap is very likely
**per-connection throttling** by the specific host. This is normal for Dood/StreamTape/Filemoon-style embed hosts and some
regional CDNs. FDM/IDM are faster there because they open 8–16 connections to the same file. yt-dlp's native downloader
**cannot split a progressive mp4 across connections**; `-N` only helps HLS/DASH. Two other possible causes:
small HLS segments on a high-latency CDN (fixed by `-N 8`) and the curl_cffi impersonation path. We need the actual slow URL
to confirm which one applies (see *Open questions*).

## Why some embedded videos fail

| Cause | Today | What IDM / sniffers do |
|---|---|---|
| Manifest has no `.m3u8` extension and a generic content type (`text/plain`, `application/octet-stream`, `.txt`, `.jpg` segments) | Missed | Inspect the response body for `#EXTM3U` / `<MPD` |
| Manifest URL only appears inside a JSON API response | Missed | Hook `fetch`/XHR/`JSON.parse` in the page (cat-catch "deep search") |
| CDN checks Cookie / Origin / UA / token headers, or the URL is signed and IP-bound | yt-dlp request rejected (403) | Capture the browser's **exact request headers** and replay them |
| Signed URL expires mid-download | Download errors out | IDM "refresh download address": re-capture the link and keep the bytes already downloaded |
| Page URL tried first with the generic extractor | Slow (`-J` per candidate, ~8 s each); can pick the wrong video | Rank sniffed streams; tie them to the frame the user clicked |
| MSE player builds the stream in JS (`blob:` src) | Missed | Hook `MediaSource.addSourceBuffer` to learn codecs; last resort: record `appendBuffer` data |
| DRM (Widevine/FairPlay) | Fails with a confusing error | Detect `requestMediaKeySystemAccess` and say plainly "DRM-protected, can't download" |

## What to borrow from IDM / FDM

1. **Dynamic segmentation with connection reuse (IDM).** Start with N connections. When one finishes, it **splits the largest
   remaining segment in half** and takes the second half, with no reconnect or handshake. Segments below a minimum size
   (~1 MB) are not split. Progress positions are saved several times a minute so a crash resumes exactly where it stopped.
   FDM's "multi-section" download works the same way in spirit.
2. **Capture the real browser request plus "refresh address" (IDM).** The extension hands over the URL **with its headers and
   cookies**. When the server later returns 403 or 410, the engine asks for a fresh URL (re-run the resolver, or ask the
   extension for the newest matching request in that tab) and **resumes into the same file** if the size or ETag still matches.
3. **Patient retries (both).** IDM defaults to around 20 retries with a pause between them and treats "network down" as "wait",
   not "fail".

## Target architecture: resolver ↔ engine split

```
          ┌───────────── Resolvers (where is the media?) ──────────────┐
          │ yt-dlp -J        → format URLs + http_headers + fragments  │
          │ extension sniff  → manifest/file URL + captured headers    │
          │ direct link      → URL                                     │
          └──────────────────────────┬─────────────────────────────────┘
                                     ▼  MediaTarget {kind: http|hls|dash, url(s), headers, size?, expiresHint}
          ┌───────────── Grabby engine (how to fetch it fast + safely) ┐
          │ HttpSegmentedJob  — IDM-style dynamic segments, N conns     │
          │ HlsJob            — parallel segments, AES-128, EXT-X-MAP   │
          │ (DASH, YouTube)   — delegate to yt-dlp download, `-N 8`     │
          │ RetryPolicy · StallWatchdog · StateFile · RefreshAddress    │
          └──────────────────────────┬─────────────────────────────────┘
                                     ▼
                        ffmpeg remux / merge (-c copy) → final file
```

yt-dlp stays as the **resolver** (1000+ extractors, signature solving with deno). It also stays as a **fallback downloader**
for protocols we don't implement. That covers DASH, and YouTube at first, since it is already at line speed and googlevideo
has range quirks; the 8×40 MB parallel-range test returned only one chunk.

### Engine details

**HTTP client.** Evaluate Electron `net.fetch` on a dedicated session. It uses Chromium's network stack, so it gets a real
Chrome TLS/HTTP2 fingerprint and the system proxy for free, which may remove the need for curl_cffi impersonation. Fallback is
`undici` with a keep-alive `Pool`. *Spike needed:* check that `net.fetch` lets us set Referer, Cookie and Origin and that it
reaches line speed.

**HttpSegmentedJob**
- Probe with `Range: bytes=0-0`: a 206 response gives size + range support. With no range support, fall back to one connection
  and full restarts.
- Preallocate the file (`<name>.grabby-part`) and write at offsets (`fs.write(fd, buf, 0, len, position)`).
- Default 8 connections (setting: 1–16); minimum split size 1 MB; honour yt-dlp's `downloader_options.http_chunk_size` when
  present.
- Persist a state file `<name>.grabby-state.json` every ~2 s: `{url, headers, size, etag, segments:[{start,end,pos}]}`.
- **Slow-connection takeover:** if one connection's speed falls under a fraction of the median for a while, split its segment
  and give half to a free connection (the IDM behaviour that keeps one bad socket from dragging out the tail).

**HlsJob**
- Parse master → pick the variant matching the chosen quality → media playlist.
- Fetch 6–8 segments at once; write in order through a small reorder buffer.
- Handle `EXT-X-KEY` AES-128 (Node `crypto`; IV defaults to the media sequence number), `EXT-X-MAP` init segments, and
  `EXT-X-BYTERANGE`.
- Track per-segment state in the state file. Remux with `ffmpeg -c copy` to mp4 at the end.
- Live / event playlists are out of scope for v1.

**RetryPolicy**
- *Transient* (ECONNRESET, ETIMEDOUT, EAI_AGAIN, 5xx, stall > 20 s with 0 bytes): retry that segment with exponential backoff
  + jitter (1 s → 60 s cap). **No retry limit while the OS reports offline**: wait for Electron `online` /
  `powerMonitor 'resume'`.
- *Throttled* (429): honour `Retry-After` and reduce that host's connection count.
- *Expired* (401/403/410 on a URL that worked before): run **RefreshAddress**: re-resolve, check size/ETag, continue.
- *Fatal* (404 on first request, disk full, DRM): fail with a clear message.
- The item stays `downloading` with a "Reconnecting in 8 s…" sub-status rather than flipping to `error`.

**Queue persistence.** Save the queue to `userData/queue.json` so paused or interrupted downloads survive an app restart. The
state files make the resume byte-exact.

### Extension upgrades

1. **Header capture.** `webRequest.onSendHeaders` with `['requestHeaders', 'extraHeaders']` (Chrome; Firefox needs no
   extraHeaders). Store Cookie/Origin/Referer/UA/Authorization with each sniffed stream and send them to the bridge.
2. **MAIN-world page hook** (`"world": "MAIN"`, `document_start`, `all_frames`): wrap `fetch`/XHR to spot `#EXTM3U` / `<MPD`
   in response bodies and manifest URLs in JSON. Hook `MediaSource.addSourceBuffer` to read codecs and
   `requestMediaKeySystemAccess` to flag DRM. Report to the content script → background.
3. **Frame association.** Record `frameId` per stream. The ⬇ button on a given `<video>` prefers streams from that frame.
4. **Stream picker like IDM's panel.** Show sniffed variants (resolution / size) directly instead of always trying the page URL
   with `yt-dlp -J` first. Keep "page URL via yt-dlp" for sites with real extractors (YouTube, etc.).
5. *(Later, optional)* MSE recording fallback for players we can't parse: capture `appendBuffer` bytes while the video plays.
   This is slow (real-time) and a last resort.

> Reference implementation for ideas 2 and 5: cat-catch (GPL-3.0). **Ideas only, no code.** Grabby is MIT.

## Phased plan

| Phase | Scope | Why first |
|---|---|---|
| **0. Quick wins** ✅ done | yt-dlp flags: `--retries infinite --fragment-retries infinite --retry-sleep exp=1:30 --socket-timeout 30 -N 8`. App-level auto-retry with backoff on non-fatal exit (yt-dlp `--continue` resumes). Persist queue. | Fixes "cut off on bad network" now; fixes the HLS latency-bound case |
| **1. Extension sniffing** ✅ done | Header capture, MAIN-world manifest + DRM detection, frame association; pass headers via `--add-header` for now | Biggest lever for "works on every embed" |
| **2. Engine core** ✅ done | `HttpSegmentedJob` + RetryPolicy + StateFile + watchdog, with a local test server that simulates drops, per-connection throttling and 403 expiry | Fixes the 500 KB/s case on progressive files |
| **3. HLS engine** ✅ done | `HlsJob` + ffmpeg remux; route sniffed HLS through it | Full control of retries/refresh on HLS |
| **4. Integration** ✅ done | yt-dlp `-J` → engine for progressive formats (non-YouTube first), RefreshAddress, stream picker UI | Ties it together |
| **5. Extras** | MSE recording fallback, speed limiter, per-host connection caps | Nice to have |

Phase 0 as built: yt-dlp runs with unlimited network retries, exponential backoff, 30 s socket timeout and `-N 8`.
In-process retries show as "Connection lost — retrying (n)". When yt-dlp exits with a transient error, the item goes
`retrying` with a 5 s → 2 min backoff (8 attempts; the budget resets once a retry gets further). Waiting while offline
doesn't use up attempts. The queue persists to `userData/queue.json`, and interrupted downloads return paused.
Also fixed: the concurrency limit ignored `preparing` items, pause/cancel did nothing while preparing, and canceling a
subtitle left it stuck. Failed items now have a Retry button.

Phase 1 as built:
- **`page-hook.js`** (page world, `document_start`, all frames) wraps fetch/XHR. It reports HLS/DASH manifests by body
  (`#EXTM3U`/`<MPD`), and also manifest URLs inside JSON/text responses. It reports DRM only when `setMediaKeys` attaches
  keys, because capability probes are common on clear content.
- **`relay.js`** forwards those findings to the background worker.
- **The background worker** captures request headers (`onSendHeaders` + `extraHeaders`; Firefox falls back without it). It
  tags streams with their frame, ranks streams from the clicked frame first (master > other HLS/DASH > media playlist > file),
  drops `.ts`/`.m4s` segments, and keeps its state in `storage.session` so an MV3 worker restart doesn't lose it.
- **The app** passes headers to yt-dlp through private temp files. Headers go in a `--config-locations` file. Cookies go in
  a host-scoped `--cookies` file, because yt-dlp drops a domain-less Cookie header, and captured cookies replace
  `--cookies-from-browser` for that run. Cookie and Authorization headers are never written to `queue.json`.
- **The renderer** probes candidates 3 at a time, takes the highest-priority one that resolves, and shows a DRM message
  when nothing resolves on a DRM page.
- **The bridge** accepts only extension origins or requests with no Origin; web pages are rejected, including the CORS
  preflight. Forwarded header names are allowlisted and CR/LF values are dropped.

Phase 2 as built (`src/main/engine/segmented.ts`):
- **Dynamic segmentation (IDM-style).** The first connection starts at byte 0 and learns size, range support and ETag. Each
  free connection takes the second half of the largest unfinished segment; segments are at least 1 MB.
- **Writing and resume.** Writes go to positions in a sparse, preallocated `.grabby-part` file. A `.grabby-state.json` is
  written every 2 s, so pause, crash or quit resume byte-exactly. The state is checked against size and ETag, and a
  changed file starts over.
- **Errors.**
  - Each segment retries with backoff (1 s → 30 s).
  - A 20 s socket-idle timeout catches stalls.
  - 429/503, or a 403 while sibling connections work, means the host caps connections, so the engine uses one fewer.
  - A 403 after data has flowed is retried 3 times, then treated as an expired link: the bytes are kept and the queue's
    backoff resumes later.
  - After 2 min with no data, the job ends and the queue's retry/backoff takes over.
- **Hand-off to yt-dlp.** For a block on the first request, HTML instead of media, ranges ignored mid-file, or a file that
  changed, the item switches to yt-dlp without spending a retry. 404 is fatal.
- **Routing.** Only Generic-extractor items with exactly one http(s) format go through the engine: sniffed mp4s, direct
  links and embed hosts. YouTube, HLS/DASH and audio-only stay on yt-dlp. The "Connections per download" setting is
  1/4/8/16, default 8.
- **Measured.** On a local host throttled to 500 KB/s per connection, a 32 MB file downloads at 0.49 MB/s with 1
  connection, **3.9 MB/s with 8** and 7.7 MB/s with 16. The same file through yt-dlp runs at 501 KiB/s.

Phase 3 as built (`src/main/engine/hls.ts`, `m3u8.ts`, shared `http.ts` / `errors.ts`):
- **Choosing the stream.** At download time yt-dlp runs `-J -f <selector>`, which picks the variant and any separate audio
  track and returns fresh media-playlist URLs. This runs again on every start or retry, so expired tokens get refreshed.
- **Downloading.**
  - Per track, N workers fetch segments in parallel and a writer appends them in order. Read-ahead is limited to 4
    segments per connection.
  - Separate audio tracks get a quarter of the connections.
  - AES-128 is supported (explicit IV, or the media-sequence IV). So are EXT-X-MAP init segments (fMP4) and
    EXT-X-BYTERANGE.
  - TS segments disguised as images are unwrapped by finding the 0x47 sync pattern.
- **Remux.** ffmpeg does a copy-only remux to mp4 with `+faststart`, or to mkv if the codecs don't fit MP4.
- **Reliability.**
  - Segments are never silently skipped.
  - A 403 after data has flowed is retried 3 times, then the job fails transiently, so the queue re-resolves fresh URLs
    and resumes.
  - Resume is byte-exact: the state is the next segment index plus bytes written, checked against a playlist fingerprint.
- **Hand-off to yt-dlp.** Live streams, master-instead-of-media playlists, SAMPLE-AES/DRM key formats, multiple init
  segments and remux failures all go to yt-dlp. Audio-only and non-Generic extractors stay on yt-dlp.
- **Security.** Cookie/Authorization are sent only to the host they were captured for; never to redirect targets or CDN
  hosts. This also fixes the Phase 2 engine.
- **yt-dlp change.** `--fragment-retries` went from `infinite` to `10`. yt-dlp retries fragment 403s too, so an expired
  token looped forever instead of exiting for the queue to re-extract.
- **Measured against yt-dlp (local tests).** Throughput was the same (15.7 s vs 14.9 s, both with 8 parallel
  fragments). On PNG-disguised segments the engine's file decodes cleanly, while yt-dlp reported success with a broken
  0-second file.

Phase 4 as built:
- **One routing path** (`engine/route.ts`). Every non-YouTube, non-audio download is resolved by yt-dlp
  (`-J -f <selector>`) on each start or retry. That gives fresh URLs and cookies, so expiring links renew on every retry.
  - Plain http(s) formats go to the multi-connection engine. Separate video and audio are downloaded in parallel and
    merged by the shared `Remuxer` (`engine/progressive.ts`).
  - HLS goes to the HLS engine.
  - Everything else goes to yt-dlp without a notice: DASH fragments, chunked or impersonation-only formats, mixed
    protocols, YouTube.
  - This replaces Phase 2/3's Generic-only `direct`/`hls` flags. Site extractors (Vimeo, archive.org, …) now benefit too.
- **Cookies scoped like a browser.** yt-dlp's per-format `cookies` field (`Domain=…; Path=…; Secure`) and captured
  browser cookies (host-only) are matched per request by domain, path and secure. Authorization is sent only to the
  captured host.
- **Refresh download address (IDM-style).** When a sniffed link has failed with 401/403/410 and yt-dlp can't renew it,
  a new ⬇ click on the same page (same page URL, `#hash` ignored) is matched to that download by stream origin+path, or
  else host. The download gets the fresh URL and headers and resumes from its bytes instead of opening the picker.
  Segmented-engine resume state is keyed by origin+path, so a new token query keeps the bytes; size and ETag are still
  checked. A final failure on an expired sniffed link explains how to refresh it.
- **Source picker.** Every candidate yt-dlp can read is listed in the quality dialog with host, stream type, height and
  duration, so an ad or trailer can be swapped for the real video. Late probe results from an older request are ignored.
- **Measured.**
  - On real archive.org traffic (25 s sample, same file): engine 121 MiB on 8 connections vs yt-dlp 89 MiB on 1
    connection, about 36% more.
  - Locally, an expired playlist link refreshed from the page resumed with 2 of 30 segments re-fetched.

Each phase ships on its own. yt-dlp stays the fallback throughout, so nothing regresses.

## Open questions

1. **Which sites/URLs** are slow (~500 KB/s) and which fail? A few real examples decide whether phase 2 or phase 3 matters
   more, and give us regression tests.
2. Bundle aria2c as a stop-gap (`--downloader aria2c -x16 -s16`) while the engine is built? It's quick, but it adds about 5 MB
   per platform and gives less control over retry and refresh. Proposal: use it only as a **benchmark comparator**, not
   shipped.
3. Default connection count: 8 (IDM default) vs 16. Some hosts ban IPs that open too many connections, so 8 with a per-host cap
   seems the safer default.

## Sources

- IDM — Dynamic Segmentation and Performance: https://cn.internetdownloadmanager.com/support/segmentation.html
- IDM — features: https://www.internetdownloadmanager.com/features.html
- FDM multi-section description (older GPL releases): https://www.neowin.net/news/free-download-manager-392
- cat-catch (GPL-3.0): https://github.com/xifangczy/cat-catch · changelog: https://www.videohelp.com/software/cat-catch/version-history
