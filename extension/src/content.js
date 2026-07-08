// Injects an IDM-style "Grabby" control pinned to the TOP-RIGHT corner of each
// <video> on the page. The control is a split button: clicking the arrow grabs
// the video; a caret opens a dropdown to grab the subtitle or video+subtitle
// (shown only when Grabby has sniffed a subtitle for this tab). Runs in EVERY
// frame (so it reaches videos inside embedded players) and pierces shadow DOM.
(function () {
  const api = globalThis.browser ?? globalThis.chrome

  // video element -> its overlay control (wrapper)
  const controls = new Map()
  // cached set of videos worth tracking; refreshed less often than we reposition
  let tracked = new Set()
  // whether Grabby has sniffed a subtitle for this tab (drives the caret/menu)
  let hasSubs = false

  function send(wrap, kind) {
    const url = location.href
    try {
      api.runtime.sendMessage({ type: 'grabby-download', url, kind }, (resp) => {
        flash(wrap, !!(resp && resp.ok))
      })
    } catch {
      flash(wrap, false)
    }
    closeMenu(wrap)
  }

  function flash(wrap, ok) {
    const main = wrap.querySelector('.grabby-main')
    if (!main) return
    main.classList.remove('grabby-ok', 'grabby-err')
    main.classList.add(ok ? 'grabby-ok' : 'grabby-err')
    main.textContent = ok ? '✓' : '✕'
    setTimeout(() => {
      main.textContent = '⬇'
      main.classList.remove('grabby-ok', 'grabby-err')
    }, 1500)
  }

  function closeMenu(wrap) {
    wrap.classList.remove('grabby-open')
  }

  function makeControl() {
    const wrap = document.createElement('div')
    wrap.className = 'grabby-fab'

    const main = document.createElement('button')
    main.className = 'grabby-main'
    main.type = 'button'
    main.textContent = '⬇'
    main.title = 'Download with Grabby'

    const caret = document.createElement('button')
    caret.className = 'grabby-caret'
    caret.type = 'button'
    caret.textContent = '▾'
    caret.title = 'Download options'

    const menu = document.createElement('div')
    menu.className = 'grabby-menu'
    menu.innerHTML =
      '<button data-kind="video" class="grabby-item">Video</button>' +
      '<button data-kind="subtitle" class="grabby-item grabby-sub">Subtitle</button>' +
      '<button data-kind="both" class="grabby-item grabby-sub">Video + Subtitle</button>'

    wrap.append(main, caret, menu)

    const stop = (e) => e.stopPropagation()
    wrap.addEventListener('mousedown', stop, true)

    main.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      send(wrap, 'video')
    })
    caret.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      refreshSubs() // re-check right before showing
      wrap.classList.toggle('grabby-open')
    })
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('.grabby-item')
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      send(wrap, btn.dataset.kind)
    })

    ;(document.body || document.documentElement).appendChild(wrap)
    applySubState(wrap)
    return wrap
  }

  // Show/hide the caret + subtitle menu items based on hasSubs.
  function applySubState(wrap) {
    wrap.classList.toggle('grabby-has-subs', hasSubs)
    if (!hasSubs) closeMenu(wrap)
  }

  let subsTimer = 0
  function refreshSubs() {
    // Throttle: at most one query per second.
    const now = Date.now()
    if (now - subsTimer < 1000) return
    subsTimer = now
    try {
      api.runtime.sendMessage({ type: 'grabby-query' }, (resp) => {
        const next = !!(resp && resp.hasSubs)
        if (next !== hasSubs) {
          hasSubs = next
          controls.forEach(applySubState)
        }
      })
    } catch {
      /* ignore */
    }
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

  // Refresh the tracked set (the expensive walk) + sync controls. Called on a slow
  // interval and on DOM mutations, not on every scroll frame.
  function refresh() {
    const found = new Set()
    collect(document, found)
    tracked = found
    for (const [video, wrap] of controls) {
      if (!found.has(video) || !video.isConnected) {
        wrap.remove()
        controls.delete(video)
      }
    }
    refreshSubs()
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

  // Cheap: just move existing controls to follow their videos.
  function position() {
    if (document.fullscreenElement) {
      controls.forEach((wrap) => (wrap.style.display = 'none'))
      return
    }
    for (const video of tracked) {
      const rect = video.getBoundingClientRect()
      if (!isRealVideo(rect)) {
        const w = controls.get(video)
        if (w) w.style.display = 'none'
        continue
      }
      let wrap = controls.get(video)
      if (!wrap) {
        wrap = makeControl()
        controls.set(video, wrap)
      }
      wrap.style.display = 'flex'
      // Coords are viewport-relative within THIS frame — what position:fixed wants.
      wrap.style.top = Math.max(6, rect.top + 10) + 'px'
      wrap.style.right = Math.max(6, window.innerWidth - rect.right + 10) + 'px'
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

  // Close any open menu when clicking elsewhere.
  window.addEventListener(
    'click',
    () => controls.forEach(closeMenu),
    true
  )
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
