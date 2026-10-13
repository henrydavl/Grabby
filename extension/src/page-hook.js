// Runs in the PAGE's JavaScript world (manifest "world": "MAIN") at document_start,
// in every frame. It sees what the site's own player loads, so it can find
// streams the network sniffer can't classify:
//  - HLS/DASH manifests served under disguised URLs or content types
//    (detected by their body: "#EXTM3U" / "<MPD"),
//  - manifest URLs buried in JSON/API responses,
//  - DRM playback (an EME MediaKeys object attached to a media element).
// Findings go to relay.js (isolated world) via window.postMessage.
;(function () {
  const TAG = '__grabby'
  if (window[TAG]) return
  Object.defineProperty(window, TAG, { value: true })

  const MAX_SCAN = 2 * 1024 * 1024 // don't read bodies bigger than this
  const MANIFEST_URL = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?/gi
  const reported = new Set()

  function post(msg) {
    try {
      window.postMessage(Object.assign({ [TAG]: 1 }, msg), '*')
    } catch {
      /* ignore */
    }
  }

  function absolute(url) {
    try {
      return new URL(String(url), location.href).href
    } catch {
      return null
    }
  }

  function report(url, kind, master) {
    if (!url || !/^https?:/i.test(url)) return
    const key = url + '|' + master
    if (reported.has(key)) return
    reported.add(key)
    post({ type: 'manifest', url, kind, master })
  }

  function stripBom(s) {
    return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
  }

  /** Cheap check on the first bytes of a body: does it look like a manifest? */
  function looksLikeManifest(text) {
    const head = stripBom(text.slice(0, 512)).trimStart()
    return head.startsWith('#EXTM3U') || head.startsWith('<?xml') || head.startsWith('<MPD')
  }

  function inspectText(url, text) {
    if (typeof text !== 'string' || !text) return
    const head = stripBom(text.slice(0, 512)).trimStart()
    if (head.startsWith('#EXTM3U')) {
      report(url, 'hls', text.includes('#EXT-X-STREAM-INF'))
      return
    }
    if (/<MPD[\s>]/.test(text.slice(0, 4096))) {
      report(url, 'dash', true)
      return
    }
    // Manifest URLs inside JSON/HTML/JS responses (often with escaped slashes).
    if (text.length > MAX_SCAN || (text.indexOf('.m3u8') < 0 && text.indexOf('.mpd') < 0)) return
    const body = text.indexOf('\\/') >= 0 ? text.replace(/\\\//g, '/') : text
    const found = body.match(MANIFEST_URL) || []
    for (const raw of found.slice(0, 10)) {
      const u = absolute(raw.replace(/&amp;/g, '&'))
      if (u) report(u, /\.mpd(\?|$)/i.test(u) ? 'dash' : 'hls', undefined)
    }
  }

  // --- fetch ------------------------------------------------------------------
  async function sniffResponse(url, res) {
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (/^(image|font|audio)\//.test(ct)) return
    if (ct.startsWith('video/') && !ct.includes('mpegurl')) return
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MAX_SCAN || !res.body) return
    const textual = /json|text|xml|mpegurl|dash|javascript/.test(ct)
    // Anything else must be generic binary (where disguised manifests hide).
    if (!textual && ct && !/octet-stream|binary/.test(ct)) return

    const reader = res.clone().body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let first = true
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      // Binary payloads (segments, images…) are rejected on the first chunk.
      if (first && !textual && !looksLikeManifest(text)) {
        reader.cancel().catch(() => {})
        return
      }
      first = false
      if (text.length > MAX_SCAN) {
        reader.cancel().catch(() => {})
        break
      }
    }
    inspectText(url, text)
  }

  const origFetch = window.fetch
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments)
      try {
        const raw = input && typeof input === 'object' && 'url' in input ? input.url : input
        const url = absolute(raw)
        p.then(
          (res) => {
            sniffResponse(res.url || url, res).catch(() => {})
          },
          () => {}
        )
      } catch {
        /* never break the page's fetch */
      }
      return p
    }
  }

  // --- XMLHttpRequest (hls.js, dash.js, video.js use it by default) -------------
  const xhrUrl = new WeakMap()
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype
  if (XHR) {
    const origOpen = XHR.open
    const origSend = XHR.send
    XHR.open = function (method, url) {
      try {
        xhrUrl.set(this, absolute(url))
      } catch {
        /* ignore */
      }
      return origOpen.apply(this, arguments)
    }
    XHR.send = function () {
      try {
        this.addEventListener('load', function () {
          try {
            sniffXhr(this)
          } catch {
            /* ignore */
          }
        })
      } catch {
        /* ignore */
      }
      return origSend.apply(this, arguments)
    }
  }

  function sniffXhr(xhr) {
    const url = xhr.responseURL || xhrUrl.get(xhr)
    const type = xhr.responseType
    if (type === '' || type === 'text') {
      const text = xhr.responseText
      if (text && text.length <= MAX_SCAN) inspectText(url, text)
    } else if (type === 'json' && xhr.response) {
      const text = JSON.stringify(xhr.response)
      if (text.length <= MAX_SCAN) inspectText(url, text)
    } else if (type === 'arraybuffer' && xhr.response && xhr.response.byteLength <= MAX_SCAN) {
      const bytes = new Uint8Array(xhr.response)
      if (looksLikeManifest(new TextDecoder().decode(bytes.subarray(0, 512)))) {
        inspectText(url, new TextDecoder().decode(bytes))
      }
    }
  }

  // --- DRM ----------------------------------------------------------------------
  // Many players probe requestMediaKeySystemAccess even for clear content, so we
  // only remember the key system there and report when MediaKeys are actually
  // attached to a media element (= protected playback).
  let lastKeySystem = ''
  if (navigator.requestMediaKeySystemAccess) {
    const origRequest = navigator.requestMediaKeySystemAccess
    navigator.requestMediaKeySystemAccess = function (keySystem) {
      lastKeySystem = String(keySystem || '')
      return origRequest.apply(this, arguments)
    }
  }
  const Media = window.HTMLMediaElement && window.HTMLMediaElement.prototype
  if (Media && Media.setMediaKeys) {
    const origSetKeys = Media.setMediaKeys
    Media.setMediaKeys = function (keys) {
      if (keys) post({ type: 'drm', keySystem: lastKeySystem || 'unknown' })
      return origSetKeys.apply(this, arguments)
    }
  }
})()
