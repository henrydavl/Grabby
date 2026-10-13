// Isolated-world bridge for page-hook.js. Loaded at document_start (content.js
// waits for document_idle, by which time the player has already fetched its
// manifest), it forwards the hook's findings to the background worker, which
// tags them with this tab + frame.
;(function () {
  const api = globalThis.browser ?? globalThis.chrome

  function send(msg) {
    try {
      const p = api.runtime.sendMessage(msg)
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* extension reloaded or worker unavailable */
    }
  }

  window.addEventListener('message', (e) => {
    // Only this frame's own page world, and only our tagged messages.
    if (e.source !== window) return
    const d = e.data
    if (!d || typeof d !== 'object' || d.__grabby !== 1) return
    if (d.type === 'manifest' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) {
      send({
        type: 'grabby-sniff',
        url: d.url,
        kind: d.kind === 'dash' ? 'dash' : 'hls',
        master: typeof d.master === 'boolean' ? d.master : undefined
      })
    } else if (d.type === 'drm') {
      send({ type: 'grabby-drm', keySystem: String(d.keySystem || 'unknown').slice(0, 64) })
    }
  })
})()
