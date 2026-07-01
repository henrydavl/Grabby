// Injects an IDM-style "Grabby" button pinned to the TOP-RIGHT corner of each
// <video> on the page. Runs in EVERY frame (so it reaches videos inside embedded
// players like StreamTape/Doodstream iframes) and pierces shadow DOM (Dailymotion
// and other web-component players). Clicking hands this frame's URL to Grabby.
(function () {
  const api = globalThis.browser ?? globalThis.chrome

  // video element -> its overlay button
  const buttons = new Map()
  // cached set of videos worth tracking; refreshed less often than we reposition
  let tracked = new Set()

  function send(btn) {
    // In an embed iframe this is the embed URL (e.g. the StreamTape player URL),
    // which is exactly what yt-dlp / the stream sniffer can act on.
    const url = location.href
    try {
      api.runtime.sendMessage({ type: 'grabby-download', url }, (resp) => {
        flash(btn, !!(resp && resp.ok))
      })
    } catch {
      flash(btn, false)
    }
  }

  function flash(btn, ok) {
    btn.classList.remove('grabby-ok', 'grabby-err')
    btn.classList.add(ok ? 'grabby-ok' : 'grabby-err')
    btn.textContent = ok ? '✓' : '✕'
    setTimeout(() => {
      btn.textContent = '⬇'
      btn.classList.remove('grabby-ok', 'grabby-err')
    }, 1500)
  }

  function makeButton() {
    const btn = document.createElement('button')
    btn.className = 'grabby-fab'
    btn.type = 'button'
    btn.textContent = '⬇'
    btn.title = 'Download with Grabby'
    btn.addEventListener('mousedown', (e) => e.stopPropagation(), true)
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      send(btn)
    })
    ;(document.body || document.documentElement).appendChild(btn)
    return btn
  }

  // Collect <video> elements, descending into open shadow roots.
  function collect(root, out) {
    let vids
    try {
      vids = root.querySelectorAll('video')
    } catch {
      return
    }
    vids.forEach((v) => out.add(v))
    let all
    try {
      all = root.querySelectorAll('*')
    } catch {
      return
    }
    for (const el of all) if (el.shadowRoot) collect(el.shadowRoot, out)
  }

  // Refresh the tracked set (the expensive walk) + sync buttons. Called on a slow
  // interval and on DOM mutations, not on every scroll frame.
  function refresh() {
    const found = new Set()
    collect(document, found)
    tracked = found
    for (const [video, btn] of buttons) {
      if (!found.has(video) || !video.isConnected) {
        btn.remove()
        buttons.delete(video)
      }
    }
    position()
  }

  function isRealVideo(rect) {
    return (
      rect.width >= 200 &&
      rect.height >= 150 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    )
  }

  // Cheap: just move existing buttons to follow their videos.
  function position() {
    if (document.fullscreenElement) {
      buttons.forEach((btn) => (btn.style.display = 'none'))
      return
    }
    for (const video of tracked) {
      const rect = video.getBoundingClientRect()
      if (!isRealVideo(rect)) {
        const b = buttons.get(video)
        if (b) b.style.display = 'none'
        continue
      }
      let btn = buttons.get(video)
      if (!btn) {
        btn = makeButton()
        buttons.set(video, btn)
      }
      btn.style.display = 'flex'
      // Coords are viewport-relative within THIS frame — what position:fixed wants.
      btn.style.top = Math.max(6, rect.top + 10) + 'px'
      btn.style.right = Math.max(6, window.innerWidth - rect.right + 10) + 'px'
    }
  }

  let posScheduled = false
  function schedulePosition() {
    if (posScheduled) return
    posScheduled = true
    requestAnimationFrame(() => {
      posScheduled = false
      position()
    })
  }

  let refreshTimer = null
  function scheduleRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refresh()
    }, 500)
  }

  window.addEventListener('scroll', schedulePosition, true)
  window.addEventListener('resize', schedulePosition, true)
  document.addEventListener('fullscreenchange', schedulePosition, true)

  new MutationObserver(scheduleRefresh).observe(document.documentElement, {
    childList: true,
    subtree: true
  })
  setInterval(refresh, 1200)
  refresh()
})()
