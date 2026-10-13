import { createServer, IncomingMessage, ServerResponse } from 'http'
import type { ExternalRequest, HttpHeaders } from '../shared/types'

// Fixed loopback port + shared token the browser extension uses. The token is
// not a secret (it ships in the extension); what keeps web pages out is the
// Origin check below — browsers always send Origin on cross-site POSTs, and only
// our extension's background has a *-extension:// origin.
export const BRIDGE_PORT = 8787
export const BRIDGE_TOKEN = 'grabby-local-bridge'

const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//

/** No Origin (non-browser client) or an extension origin. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  return !origin || EXTENSION_ORIGIN.test(origin)
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (origin && EXTENSION_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Grabby-Token')
}

// Browser request headers worth replaying for a stream; everything else
// (Host, Range, Accept-Encoding, sec-fetch-*, …) is the downloader's business.
const FORWARDED_HEADER = /^(cookie|authorization|origin|referer|user-agent|x-[a-z0-9-]+)$/i

function sanitizeHeaders(raw: unknown): HttpHeaders | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: HttpHeaders = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!FORWARDED_HEADER.test(name) || typeof value !== 'string') continue
    if (value.length > 8192 || /[\r\n]/.test(value)) continue
    out[name] = value
  }
  return Object.keys(out).length ? out : undefined
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
export function startBridge(
  onRequest: (req: ExternalRequest) => void,
  port = BRIDGE_PORT
): void {
  const server = createServer(async (req, res) => {
    cors(req, res)

    if (!originAllowed(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }

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
          // streams may be plain URLs (old) or {url, referer, headers} objects (new).
          streams?: (string | { url?: string; referer?: string; headers?: unknown })[]
          subs?: { url?: string; referer?: string; label?: string; ext?: string; headers?: unknown }[]
          referer?: string
          kind?: 'video' | 'subtitle' | 'both'
          drm?: unknown
        }
        const valid = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\//i.test(u)
        const pageReferer = valid(payload.referer) ? payload.referer : undefined

        // Page URL first (best quality via yt-dlp's site extractors), then sniffed
        // streams for sites yt-dlp can't read from the page (Doodstream et al).
        const candidates: ExternalRequest['candidates'] = []
        if (valid(payload.url)) candidates.push({ url: payload.url })
        for (const s of payload.streams ?? []) {
          if (typeof s === 'string') {
            if (valid(s)) candidates.push({ url: s, referer: pageReferer })
          } else if (s && valid(s.url)) {
            candidates.push({
              url: s.url,
              referer: valid(s.referer) ? s.referer : pageReferer,
              headers: sanitizeHeaders(s.headers)
            })
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
            ext: typeof s.ext === 'string' ? s.ext : undefined,
            headers: sanitizeHeaders(s.headers)
          }))

        const kind = payload.kind === 'subtitle' || payload.kind === 'both' ? payload.kind : 'video'

        // 'subtitle' needs at least a sub; 'video'/'both' need at least a candidate.
        const haveVideo = unique.length > 0
        const haveSub = subtitles.length > 0
        if ((kind === 'subtitle' && haveSub) || (kind !== 'subtitle' && haveVideo)) {
          const drm =
            typeof payload.drm === 'string' && payload.drm ? payload.drm.slice(0, 64) : undefined
          onRequest({ candidates: unique, subtitles, kind, drm })
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

  server.listen(port, '127.0.0.1', () => {
    console.log(`[grabby] bridge listening on http://127.0.0.1:${port}`)
  })
}
