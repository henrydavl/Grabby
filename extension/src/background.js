// Background worker:
//  1. Sniffs media stream + subtitle requests per tab — by URL extension, by
//     response Content-Type, and (via page-hook.js) by response BODY, so it
//     catches disguised manifests and manifest URLs hidden in API responses.
//  2. Captures the browser's own request headers (cookies, Origin, exact
//     Referer…) for those streams, so Grabby can replay them to gated CDNs.
//  3. Records which frame requested each stream, so the ⬇ button on a video
//     prefers that player's streams over ads in other frames.
//  4. Keeps all of that in storage.session (memory only), because an MV3 worker
//     is shut down after ~30s idle and would otherwise forget everything.
//  5. On the floating/toolbar button, sends the page URL + sniffed streams +
//     sniffed subtitles to Grabby's local bridge, launching Grabby first if it's
//     not running (via the grabby:// protocol, like IDM/FDM).
const api = globalThis.browser ?? globalThis.chrome

const HOST = 'http://127.0.0.1:8787'
const BRIDGE = HOST + '/add'
const HEALTH = HOST + '/health'
const TOKEN = 'grabby-local-bridge' // must match BRIDGE_TOKEN in the app

// tabId -> Map(url -> { referer, kind, frameId, master?, headers? })   kind: 'hls' | 'dash' | 'file'
const streamsByTab = new Map()
// tabId -> Map(url -> { referer, label, ext, frameId, headers? })
const subsByTab = new Map()
// tabId -> EME key system, when the page attached MediaKeys (DRM playback)
const drmByTab = new Map()
// tabId -> Map(url -> headers): recent request headers, to attach to streams
// identified only after the request went out (by Content-Type or body).
const recentHeaders = new Map()
const MAX_PER_TAB = 40
const MAX_RECENT_HEADERS = 150

// --- persistence across worker restarts --------------------------------------
const sessionStore = api.storage && api.storage.session

function serialize(byTab) {
  return [...byTab].map(([tabId, map]) => [tabId, [...map]])
}

function hydrate(byTab, saved) {
  for (const [tabId, entries] of saved || []) {
    let map = byTab.get(tabId)
    if (!map) byTab.set(tabId, (map = new Map()))
    for (const [url, meta] of entries) if (!map.has(url)) map.set(url, meta)
  }
}

// Everything that READS sniffed state awaits this first.
const ready = (async () => {
  if (!sessionStore) return
  try {
    const saved = await sessionStore.get(['streams', 'subs', 'drm'])
    hydrate(streamsByTab, saved.streams)
    hydrate(subsByTab, saved.subs)
    for (const [tabId, keySystem] of saved.drm || []) {
      if (!drmByTab.has(tabId)) drmByTab.set(tabId, keySystem)
    }
  } catch {
    /* start empty */
  }
})()

let persistTimer = 0
function persist() {
  if (!sessionStore || persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = 0
    sessionStore
      .set({ streams: serialize(streamsByTab), subs: serialize(subsByTab), drm: [...drmByTab] })
      .catch(() => {})
  }, 500)
}

// --- classification ----------------------------------------------------------
function kindFromUrl(rawUrl) {
  const path = rawUrl.split('?')[0].toLowerCase()
  if (path.endsWith('.m3u8')) return 'hls'
  if (path.endsWith('.mpd')) return 'dash'
  // Not .ts/.m4s: those are HLS/DASH segments, not whole videos.
  if (/\.(mp4|m4v|webm|mov|mkv|flv)$/.test(path)) return 'file'
  return null
}

function kindFromContentType(ct) {
  if (!ct) return null
  ct = ct.toLowerCase()
  if (ct.includes('mpegurl')) return 'hls' // application/vnd.apple.mpegurl, x-mpegurl
  if (ct.includes('dash+xml')) return 'dash'
  if (ct.startsWith('video/mp2t') || ct.includes('iso.segment')) return null // segments
  if (ct.startsWith('video/')) return 'file'
  return null
}

// --- subtitle detection ------------------------------------------------------
function subExtFromUrl(rawUrl) {
  const path = rawUrl.split('?')[0].toLowerCase()
  const m = path.match(/\.(srt|vtt|ass|ssa|sub|smi|ttml|dfxp)$/)
  return m ? m[1] : null
}

function subExtFromContentType(ct) {
  if (!ct) return null
  ct = ct.toLowerCase()
  if (ct.includes('vtt')) return 'vtt'
  if (ct.includes('subrip') || ct.includes('srt')) return 'srt'
  if (ct.includes('ssa') || ct.includes('ass')) return 'ass'
  if (ct.includes('ttml')) return 'ttml'
  return null
}

// Best-effort human label from a subtitle URL: a language code or name in the
// path/filename (…/English.srt, …/sub.en.vtt, …?lang=ar).
const LANG = {
  en: 'English', ar: 'Arabic', km: 'Khmer', id: 'Indonesia', ms: 'Malay',
  th: 'Thai', vi: 'Vietnamese', zh: 'Chinese', ko: 'Korean', ja: 'Japanese',
  es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian',
  hi: 'Hindi', tr: 'Turkish', it: 'Italian'
}
function labelFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl)
    const q = u.searchParams.get('lang') || u.searchParams.get('language') || u.searchParams.get('label')
    if (q) return LANG[q.toLowerCase()] || q
    const file = decodeURIComponent(u.pathname.split('/').pop() || '')
    const stem = file.replace(/\.[a-z0-9]+$/i, '')
    // trailing lang code like "movie.en" or "movie_ar"
    const code = stem.match(/[._-]([a-z]{2,3})$/i)
    if (code && LANG[code[1].toLowerCase()]) return LANG[code[1].toLowerCase()]
    // a full language word anywhere in the name
    for (const name of Object.values(LANG)) {
      if (stem.toLowerCase().includes(name.toLowerCase())) return name
    }
    return stem || undefined
  } catch {
    return undefined
  }
}

// --- remembering -------------------------------------------------------------
function tabMap(byTab, tabId) {
  let map = byTab.get(tabId)
  if (!map) byTab.set(tabId, (map = new Map()))
  return map
}

function headersFor(tabId, url) {
  const map = recentHeaders.get(tabId)
  return map ? map.get(url) : undefined
}

function remember(tabId, url, kind, referer, frameId, master) {
  if (tabId < 0 || !url || url.startsWith('blob:') || url.startsWith('data:')) return
  const map = tabMap(streamsByTab, tabId)
  const prev = map.get(url)
  if (prev) {
    // Later sightings can add detail (e.g. the page hook learning it's a master playlist).
    if (master !== undefined) prev.master = master
    if (!prev.headers) prev.headers = headersFor(tabId, url)
  } else {
    if (map.size >= MAX_PER_TAB) map.delete(map.keys().next().value) // drop oldest
    map.set(url, {
      referer: referer || undefined,
      kind,
      frameId,
      master,
      headers: headersFor(tabId, url)
    })
  }
  persist()
}

function rememberSub(tabId, url, ext, referer, frameId) {
  if (tabId < 0 || !url || url.startsWith('blob:') || url.startsWith('data:')) return
  const map = tabMap(subsByTab, tabId)
  if (map.has(url)) return
  if (map.size >= MAX_PER_TAB) map.delete(map.keys().next().value)
  map.set(url, {
    referer: referer || undefined,
    ext,
    label: labelFromUrl(url),
    frameId,
    headers: headersFor(tabId, url)
  })
  persist()
}

function forgetTab(tabId) {
  streamsByTab.delete(tabId)
  subsByTab.delete(tabId)
  drmByTab.delete(tabId)
  recentHeaders.delete(tabId)
  persist()
}

// --- network observation -----------------------------------------------------
// Fast path: recognizable extensions, seen before the response.
api.webRequest.onBeforeRequest.addListener(
  (d) => {
    const ref = d.documentUrl || d.originUrl
    const kind = kindFromUrl(d.url)
    if (kind) remember(d.tabId, d.url, kind, ref, d.frameId)
    const sub = subExtFromUrl(d.url)
    if (sub) rememberSub(d.tabId, d.url, sub, ref, d.frameId)
  },
  { urls: ['<all_urls>'] }
)

// Request headers the browser actually sent. Only the kinds of requests players
// make (XHR/fetch/media) and only headers worth replaying; segments are skipped
// so they don't flush the manifests out of the small per-tab cache.
const HEADER_REQUEST_TYPES = new Set(['xmlhttprequest', 'media', 'other', 'object'])
const KEEP_HEADER = /^(cookie|authorization|origin|referer|user-agent|x-[a-z0-9-]+)$/i
const SEGMENT_URL = /\.(ts|m4s|m4f|aac|cmfv|cmfa)(\?|$)/i

function onSendHeaders(d) {
  if (d.tabId < 0 || !HEADER_REQUEST_TYPES.has(d.type) || SEGMENT_URL.test(d.url)) return
  const headers = {}
  for (const h of d.requestHeaders || []) {
    if (h.value != null && KEEP_HEADER.test(h.name)) headers[h.name] = h.value
  }
  if (Object.keys(headers).length === 0) return
  const map = tabMap(recentHeaders, d.tabId)
  map.delete(d.url) // re-insert as newest
  map.set(d.url, headers)
  if (map.size > MAX_RECENT_HEADERS) map.delete(map.keys().next().value)

  // Streams/subs recognized by URL in onBeforeRequest get their headers now.
  const stream = streamsByTab.get(d.tabId)?.get(d.url)
  const sub = subsByTab.get(d.tabId)?.get(d.url)
  if (stream && !stream.headers) stream.headers = headers
  if (sub && !sub.headers) sub.headers = headers
  if ((stream && stream.headers === headers) || (sub && sub.headers === headers)) persist()
}

// Chrome hides Cookie/Referer/Origin unless 'extraHeaders' is requested;
// Firefox shows them anyway and rejects that option.
try {
  api.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ['<all_urls>'] }, [
    'requestHeaders',
    'extraHeaders'
  ])
} catch {
  api.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ['<all_urls>'] }, [
    'requestHeaders'
  ])
}

// Robust path: inspect the response Content-Type (catches extension-less URLs).
api.webRequest.onHeadersReceived.addListener(
  (d) => {
    const header = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')
    const ct = header && header.value
    const ref = d.documentUrl || d.originUrl
    const kind = kindFromContentType(ct)
    if (kind) remember(d.tabId, d.url, kind, ref, d.frameId)
    // Only trust content-type for subs if the URL also looks subtitle-ish, since
    // text/vtt is reliable but some servers mislabel; the URL check keeps it tight.
    const sub = subExtFromContentType(ct)
    if (sub && !kind) rememberSub(d.tabId, d.url, subExtFromUrl(d.url) || sub, ref, d.frameId)
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
)

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') forgetTab(tabId)
})
api.tabs.onRemoved.addListener(forgetTab)

// --- choosing what to send -----------------------------------------------------
// Lower is better: the clicked player's own frame first, then master playlists
// (all qualities) before single-variant playlists, then DASH, then plain files.
function streamRank(s, frameId) {
  const frame = frameId != null && s.frameId !== frameId ? 10 : 0
  let kind = 3
  if (s.kind === 'hls') kind = s.master === true ? 0 : s.master === false ? 2 : 1
  else if (s.kind === 'dash') kind = 1
  return frame + kind
}

// Returns {url, referer, headers} objects, best first.
function pickStreams(tabId, frameId) {
  const map = streamsByTab.get(tabId)
  if (!map) return []
  return [...map.entries()]
    .map(([url, meta]) => ({ url, ...meta }))
    .sort((a, b) => streamRank(a, frameId) - streamRank(b, frameId))
    .slice(0, 8)
    .map((s) => ({ url: s.url, referer: s.referer, headers: s.headers }))
}

function pickSubs(tabId) {
  const map = subsByTab.get(tabId)
  if (!map) return []
  return [...map.entries()].slice(0, 12).map(([url, meta]) => ({
    url,
    referer: meta.referer,
    label: meta.label,
    ext: meta.ext,
    headers: meta.headers
  }))
}

// --- talking to Grabby, launching it if needed -------------------------------
async function isGrabbyUp() {
  try {
    const res = await fetch(HEALTH, { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}

// Launch Grabby via its custom protocol (registered by the packaged app), then
// wait for the bridge to come up. A hidden tab is the only reliable way for an
// MV3 service worker to trigger an OS protocol handler.
async function launchGrabby() {
  let tab
  try {
    tab = await api.tabs.create({ url: 'grabby://open', active: false })
  } catch {
    return false
  }
  // Poll /health for up to ~8s while the app starts.
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await isGrabbyUp()) break
  }
  // The grabby:// tab either errored or is blank — close it.
  if (tab && tab.id != null) {
    try {
      await api.tabs.remove(tab.id)
    } catch {
      /* ignore */
    }
  }
  return isGrabbyUp()
}

async function postToBridge(payload) {
  const res = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Grabby-Token': TOKEN },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error('bridge ' + res.status)
  return res.json()
}

// Send to Grabby; if the bridge is down, launch the app first (IDM/FDM-style).
async function sendToGrabby(payload) {
  try {
    return await postToBridge(payload)
  } catch (e) {
    if (await launchGrabby()) return postToBridge(payload)
    throw e
  }
}

function buildPayload(pageUrl, tabId, kind, frameId) {
  return {
    url: pageUrl,
    streams: tabId != null ? pickStreams(tabId, frameId) : [],
    subs: tabId != null ? pickSubs(tabId) : [],
    referer: pageUrl,
    kind: kind || 'video',
    drm: tabId != null ? drmByTab.get(tabId) : undefined
  }
}

// Messages from the content scripts (floating button dropdown, page-hook relay).
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false
  const tabId = sender.tab ? sender.tab.id : undefined
  const frameId = sender.frameId

  // page-hook.js found a manifest by its body / inside an API response.
  if (msg.type === 'grabby-sniff' && tabId != null) {
    const kind = msg.kind === 'dash' ? 'dash' : 'hls'
    const master = typeof msg.master === 'boolean' ? msg.master : undefined
    remember(tabId, msg.url, kind, sender.url, frameId, master)
    return false
  }
  if (msg.type === 'grabby-drm' && tabId != null) {
    drmByTab.set(tabId, String(msg.keySystem || 'unknown'))
    persist()
    return false
  }

  // The dropdown asks whether subtitles exist so it can enable/disable items.
  if (msg.type === 'grabby-query') {
    ready.then(() => sendResponse({ hasSubs: tabId != null && pickSubs(tabId).length > 0 }))
    return true
  }

  if (msg.type === 'grabby-download' && msg.url) {
    ready
      .then(() => sendToGrabby(buildPayload(msg.url, tabId, msg.kind, frameId)))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  return false
})

// From the toolbar button — send the active tab's URL + everything sniffed.
api.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url) return
  await ready
  const kind = pickSubs(tab.id).length > 0 ? 'both' : 'video'
  try {
    await sendToGrabby(buildPayload(tab.url, tab.id, kind))
    flashBadge('✓', '#16a34a')
  } catch {
    flashBadge('!', '#dc2626')
  }
})

function flashBadge(text, color) {
  try {
    api.action.setBadgeText({ text })
    api.action.setBadgeBackgroundColor({ color })
    setTimeout(() => api.action.setBadgeText({ text: '' }), 2000)
  } catch {
    /* badge is best-effort */
  }
}
