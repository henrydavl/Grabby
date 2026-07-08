import { createServer, IncomingMessage, ServerResponse } from 'http'
import type { ExternalRequest } from '../shared/types'

// Fixed loopback port + shared token the browser extension uses. The token keeps
// random web pages from POSTing downloads to the local server; it's not a secret
// (it ships in the extension) — just a simple "this came from our extension" check.
export const BRIDGE_PORT = 8787
export const BRIDGE_TOKEN = 'grabby-local-bridge'

function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Grabby-Token')
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) req.destroy() // guard against abuse
    })
    req.on('end', () => resolve(data))
  })
}

/**
 * Start the loopback bridge the browser extension talks to. Calls `onRequest`
 * with the page URL + any sniffed stream URLs whenever the extension asks to
 * download something. Bound to 127.0.0.1 only.
 */
export function startBridge(onRequest: (req: ExternalRequest) => void): void {
  const server = createServer(async (req, res) => {
    cors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, app: 'grabby' }))
      return
    }

    if (req.method === 'POST' && req.url === '/add') {
      if (req.headers['x-grabby-token'] !== BRIDGE_TOKEN) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      try {
        const body = await readBody(req)
        const payload = JSON.parse(body || '{}') as {
          url?: string
          // streams may be plain URLs (old) or {url, referer} objects (new).
          streams?: (string | { url?: string; referer?: string })[]
          subs?: { url?: string; referer?: string; label?: string; ext?: string }[]
          referer?: string
          kind?: 'video' | 'subtitle' | 'both'
        }
        const valid = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)
        const pageReferer = valid(payload.referer) ? payload.referer : undefined

        // Page URL first (best quality via yt-dlp's site extractors), then sniffed
        // streams for sites yt-dlp can't read from the page (Doodstream et al).
        const candidates: { url: string; referer?: string }[] = []
        if (valid(payload.url)) candidates.push({ url: payload.url })
        for (const s of payload.streams ?? []) {
          if (typeof s === 'string') {
            if (valid(s)) candidates.push({ url: s, referer: pageReferer })
          } else if (s && valid(s.url)) {
            candidates.push({ url: s.url, referer: valid(s.referer) ? s.referer : pageReferer })
          }
        }
        // De-dupe by URL, keeping the first (with its referer).
        const seen = new Set<string>()
        const unique = candidates.filter((c) => !seen.has(c.url) && seen.add(c.url))

        // Sniffed subtitle files (offered via the button dropdown).
        const seenSub = new Set<string>()
        const subtitles = (payload.subs ?? [])
          .filter((s) => s && valid(s.url) && !seenSub.has(s.url!) && seenSub.add(s.url!))
          .map((s) => ({
            url: s.url!,
            referer: valid(s.referer) ? s.referer : pageReferer,
            label: typeof s.label === 'string' ? s.label : undefined,
            ext: typeof s.ext === 'string' ? s.ext : undefined
          }))

        const kind = payload.kind === 'subtitle' || payload.kind === 'both' ? payload.kind : 'video'

        // 'subtitle' needs at least a sub; 'video'/'both' need at least a candidate.
        const haveVideo = unique.length > 0
        const haveSub = subtitles.length > 0
        if ((kind === 'subtitle' && haveSub) || (kind !== 'subtitle' && haveVideo)) {
          onRequest({ candidates: unique, subtitles, kind })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, candidates: unique.length, subtitles: subtitles.length }))
        } else {
          res.writeHead(400)
          res.end('missing or invalid url')
        }
      } catch {
        res.writeHead(400)
        res.end('bad request')
      }
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  server.on('error', (err) => {
    // Most likely the port is already in use (another Grabby instance). Non-fatal.
    console.error('[grabby] bridge server error:', err.message)
  })

  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`[grabby] bridge listening on http://127.0.0.1:${BRIDGE_PORT}`)
  })
}
