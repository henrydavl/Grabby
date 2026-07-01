// Background worker:
//  1. Sniffs media stream requests per tab — by URL extension AND by response
//     Content-Type (so it catches extension-less CDN URLs like Doodstream's).
//  2. Records the frame URL that requested each stream, to use as its Referer.
//  3. On the floating/toolbar button, sends the page URL + sniffed streams to
//     Grabby's local bridge. The app tries the page URL first then the streams.
const api = globalThis.browser ?? globalThis.chrome

const BRIDGE = 'http://127.0.0.1:8787/add'
const TOKEN = 'grabby-local-bridge' // must match BRIDGE_TOKEN in the app

// tabId -> Map(url -> { referer, kind })   kind: 'hls' | 'dash' | 'file'
const streamsByTab = new Map()
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

// Fast path: recognizable extensions, seen before the response.
api.webRequest.onBeforeRequest.addListener(
  (d) => {
    const kind = kindFromUrl(d.url)
    if (kind) remember(d.tabId, d.url, kind, d.documentUrl || d.originUrl)
  },
  { urls: ['<all_urls>'] }
)

// Robust path: inspect the response Content-Type (catches extension-less URLs).
api.webRequest.onHeadersReceived.addListener(
  (d) => {
    const header = (d.responseHeaders || []).find((h) => h.name.toLowerCase() === 'content-type')
    const kind = kindFromContentType(header && header.value)
    if (kind) remember(d.tabId, d.url, kind, d.documentUrl || d.originUrl)
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
)

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'loading') streamsByTab.delete(tabId)
})
api.tabs.onRemoved.addListener((tabId) => streamsByTab.delete(tabId))

// Manifests (HLS/DASH) first, then progressive files. Returns {url, referer} objects.
function pickStreams(tabId) {
  const map = streamsByTab.get(tabId)
  if (!map) return []
  const entries = [...map.entries()].map(([url, meta]) => ({ url, ...meta }))
  const rank = { hls: 0, dash: 1, file: 2 }
  entries.sort((a, b) => rank[a.kind] - rank[b.kind])
  return entries.slice(0, 8).map((e) => ({ url: e.url, referer: e.referer }))
}

async function sendToGrabby(pageUrl, tabId) {
  const res = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Grabby-Token': TOKEN },
    body: JSON.stringify({
      url: pageUrl,
      streams: tabId != null ? pickStreams(tabId) : [],
      referer: pageUrl
    })
  })
  if (!res.ok) throw new Error('bridge ' + res.status)
  return res.json()
}

// From the floating button (content script). In an embed iframe, msg.url is the
// embed URL — the right Referer for that frame's streams.
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'grabby-download' && msg.url) {
    const tabId = sender.tab ? sender.tab.id : undefined
    sendToGrabby(msg.url, tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  return false
})

// From the toolbar button — send the active tab's URL + its sniffed streams.
api.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.url) return
  try {
    await sendToGrabby(tab.url, tab.id)
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
