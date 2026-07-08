// Background worker:
//  1. Sniffs media stream + subtitle requests per tab — by URL extension AND by
//     response Content-Type (so it catches extension-less CDN URLs).
//  2. Records the frame URL that requested each stream, to use as its Referer.
//  3. On the floating/toolbar button, sends the page URL + sniffed streams +
//     sniffed subtitles to Grabby's local bridge, launching Grabby first if it's
//     not running (via the grabby:// protocol, like IDM/FDM).
const api = globalThis.browser ?? globalThis.chrome

const HOST = 'http://127.0.0.1:8787'
const BRIDGE = HOST + '/add'
const HEALTH = HOST + '/health'
const TOKEN = 'grabby-local-bridge' // must match BRIDGE_TOKEN in the app

// tabId -> Map(url -> { referer, kind })   kind: 'hls' | 'dash' | 'file'
const streamsByTab = new Map()
// tabId -> Map(url -> { referer, label, ext })
const subsByTab = new Map()
const MAX_PER_TAB = 40

function kindFromUrl(rawUrl) {
  const path = rawUrl.split('?')[0].toLowerCase()
  if (path.endsWith('.m3u8')) return 'hls'
  if (path.endsWith('.mpd')) return 'dash'
  if (/\.(mp4|m4v|webm|mov|mkv|flv|ts|m4s)$/.test(path)) return 'file'
  return null
}

function kindFromContentType(ct) {
  if (!ct) return null
  ct = ct.toLowerCase()
  if (ct.includes('mpegurl')) return 'hls' // application/vnd.apple.mpegurl, x-mpegurl
  if (ct.includes('dash+xml')) return 'dash'
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

function remember(tabId, url, kind, referer) {
  if (tabId < 0 || !url || url.startsWith('blob:') || url.startsWith('data:')) return
  let map = streamsByTab.get(tabId)
  if (!map) {
    map = new Map()
    streamsByTab.set(tabId, map)
  }
  if (!map.has(url)) {
    if (map.size >= MAX_PER_TAB) map.delete(map.keys().next().value) // drop oldest
    map.set(url, { referer: referer || undefined, kind })
  }
}

function rememberSub(tabId, url, ext, referer) {
  if (tabId < 0 || !url || url.startsWith('blob:') || url.startsWith('data:')) return
  let map = subsByTab.get(tabId)
  if (!map) {
    map = new Map()
    subsByTab.set(tabId, map)
  }
  if (!map.has(url)) {
    if (map.size >= MAX_PER_TAB) map.delete(map.keys().next().value)
    map.set(url, { referer: referer || undefined, ext, label: labelFromUrl(url) })
  }
}

// Fast path: recognizable extensions, seen before the response.
api.webRequest.onBeforeRequest.addListener(
  (d) => {
    const ref = d.documentUrl || d.originUrl
    const kind = kindFromUrl(d.url)
    if (kind) remember(d.tabId, d.url, kind, ref)
    const sub = subExtFromUrl(d.url)
    if (sub) rememberSub(d.tabId, d.url, sub, ref)
  },
  { urls: ['<all_urls>'] }
)

// Robust path: inspect the response Content-Type (catches extension-less URLs).
api.webRequest.onHeadersReceived.addListener(
  (d) => {
    const header = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')
    const ct = header && header.value
    const ref = d.documentUrl || d.originUrl
    const kind = kindFromContentType(ct)
    if (kind) remember(d.tabId, d.url, kind, ref)
    // Only trust content-type for subs if the URL also looks subtitle-ish, since
    // text/vtt is reliable but some servers mislabel; the URL check keeps it tight.
    const sub = subExtFromContentType(ct)
    if (sub && !kind) rememberSub(d.tabId, d.url, subExtFromUrl(d.url) || sub, ref)
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
)

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') {
    streamsByTab.delete(tabId)
    subsByTab.delete(tabId)
  }
})
api.tabs.onRemoved.addListener((tabId) => {
  streamsByTab.delete(tabId)
  subsByTab.delete(tabId)
})

// Manifests (HLS/DASH) first, then progressive files. Returns {url, referer} objects.
function pickStreams(tabId) {
  const map = streamsByTab.get(tabId)
  if (!map) return []
  const entries = [...map.entries()].map(([url, meta]) => ({ url, ...meta }))
  const rank = { hls: 0, dash: 1, file: 2 }
  entries.sort((a, b) => rank[a.kind] - rank[b.kind])
  return entries.slice(0, 8).map((e) => ({ url: e.url, referer: e.referer }))
}

function pickSubs(tabId) {
  const map = subsByTab.get(tabId)
  if (!map) return []
  return [...map.entries()]
    .slice(0, 12)
    .map(([url, meta]) => ({ url, referer: meta.referer, label: meta.label, ext: meta.ext }))
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

function buildPayload(pageUrl, tabId, kind) {
  return {
    url: pageUrl,
    streams: tabId != null ? pickStreams(tabId) : [],
    subs: tabId != null ? pickSubs(tabId) : [],
    referer: pageUrl,
    kind: kind || 'video'
  }
}

// Messages from the content script (floating button dropdown).
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false
  const tabId = sender.tab ? sender.tab.id : undefined

  // The dropdown asks whether subtitles exist so it can enable/disable items.
  if (msg.type === 'grabby-query') {
    sendResponse({ hasSubs: tabId != null && pickSubs(tabId).length > 0 })
    return true // (sync response, but keep the channel tidy)
  }

  if (msg.type === 'grabby-download' && msg.url) {
    sendToGrabby(buildPayload(msg.url, tabId, msg.kind))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  return false
})

// From the toolbar button — send the active tab's URL + everything sniffed.
api.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url) return
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
