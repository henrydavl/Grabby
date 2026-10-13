import { request as httpRequest, Agent as HttpAgent, type ClientRequest, type IncomingMessage } from 'http'
import { request as httpsRequest, Agent as HttpsAgent } from 'https'
import type { HttpHeaders } from '../../shared/types'
import { EngineError, httpError, toEngineError } from './errors'

const STALL_MS = 20_000 // no bytes for this long = dead connection
const MAX_REDIRECTS = 5

/** A cookie with the scope a browser would apply to it. */
export interface CookieEntry {
  name: string
  value: string
  /** Lower-case domain without a leading dot. */
  domain: string
  /** Only for exactly `domain` (no subdomains). */
  hostOnly: boolean
  path: string
  secure: boolean
}

const COOKIE_ATTRIBUTES = new Set(['domain', 'path', 'expires', 'max-age', 'secure', 'httponly', 'samesite'])

/**
 * Parse yt-dlp's per-format `cookies` field — "a=1; Domain=.x.com; Path=/; b=2;
 * Domain=…" — into scoped entries. Attributes follow the cookie they belong to.
 */
export function parseYtdlpCookies(field: string | undefined): CookieEntry[] {
  const out: CookieEntry[] = []
  for (const part of (field ?? '').split(';')) {
    const eq = part.indexOf('=')
    const name = (eq >= 0 ? part.slice(0, eq) : part).trim()
    const value = eq >= 0 ? part.slice(eq + 1).trim() : ''
    if (!name) continue
    const attr = name.toLowerCase()
    const current = out[out.length - 1]
    if (COOKIE_ATTRIBUTES.has(attr)) {
      if (!current) continue
      if (attr === 'domain' && value) {
        current.hostOnly = !value.startsWith('.')
        current.domain = value.replace(/^\./, '').toLowerCase()
      } else if (attr === 'path' && value) current.path = value
      else if (attr === 'secure') current.secure = true
      continue
    }
    out.push({ name, value, domain: '', hostOnly: false, path: '/', secure: false })
  }
  return out.filter((c) => c.domain)
}

/** A browser-captured `Cookie:` header: host-only cookies for the host it was sent to. */
export function cookiesFromHeader(header: string | undefined, host: string | null): CookieEntry[] {
  if (!header || !host) return []
  return header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.indexOf('=') > 0)
    .map((p) => ({
      name: p.slice(0, p.indexOf('=')).trim(),
      value: p.slice(p.indexOf('=') + 1).trim(),
      domain: host.toLowerCase(),
      hostOnly: true,
      path: '/',
      secure: false
    }))
}

function cookieMatches(c: CookieEntry, u: URL): boolean {
  const host = u.hostname.toLowerCase()
  const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`)
  return domainOk && u.pathname.startsWith(c.path) && (!c.secure || u.protocol === 'https:')
}

/** Hostname of a URL, or null if it doesn't parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Keep-alive HTTP(S) client shared by one download's connections. Credentials
 * are scoped the way a browser scopes them: cookies by domain/path/secure, and
 * Authorization only to the host it was captured for — never to redirect
 * targets or unrelated CDN hosts.
 */
export class HttpClient {
  private readonly httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 32 })
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32 })
  private readonly cookies: CookieEntry[]

  /**
   * @param credentialHost host the captured Cookie/Authorization headers were
   *   sent to (null: never send them).
   * @param cookies extra scoped cookies (e.g. yt-dlp's for the format).
   */
  constructor(
    private readonly headers: HttpHeaders,
    private readonly credentialHost: string | null,
    cookies: CookieEntry[] = []
  ) {
    const captured = Object.entries(headers).find(([n]) => n.toLowerCase() === 'cookie')?.[1]
    // Captured browser cookies win over same-named ones from yt-dlp.
    this.cookies = [...cookiesFromHeader(captured, credentialHost), ...cookies]
  }

  destroy(): void {
    this.httpAgent.destroy()
    this.httpsAgent.destroy()
  }

  private headersFor(u: URL, range: string | null): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(this.headers)) {
      const lower = name.toLowerCase()
      if (lower === 'host' || lower === 'accept-encoding' || lower === 'range' || lower === 'cookie') continue
      if (lower === 'authorization' && u.hostname !== this.credentialHost) continue
      out[name] = value
    }
    const seen = new Set<string>()
    const jar = this.cookies.filter((c) => cookieMatches(c, u) && !seen.has(c.name) && seen.add(c.name))
    if (jar.length) out.Cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ')
    // Byte ranges must refer to the raw file, never a compressed stream.
    out['Accept-Encoding'] = 'identity'
    if (range) out.Range = range
    return out
  }

  /** Open a GET (following redirects); the caller consumes or destroys the response. */
  open(
    url: string,
    range: string | null,
    redirects = 0
  ): Promise<{ res: IncomingMessage; req: ClientRequest; url: string }> {
    return new Promise((resolve, reject) => {
      let u: URL
      try {
        u = new URL(url)
      } catch {
        reject(new EngineError('invalid URL', 'fatal'))
        return
      }
      const secure = u.protocol === 'https:'
      const req = (secure ? httpsRequest : httpRequest)(
        u,
        {
          method: 'GET',
          agent: secure ? this.httpsAgent : this.httpAgent,
          headers: this.headersFor(u, range)
        },
        (res) => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            if (redirects >= MAX_REDIRECTS) {
              reject(new EngineError('too many redirects', 'fallback'))
              return
            }
            // Redirect targets (signed CDN URLs) are resolved fresh per request,
            // so an expired one is simply re-issued.
            this.open(new URL(res.headers.location, u).href, range, redirects + 1).then(resolve, reject)
            return
          }
          resolve({ res, req, url: u.href })
        }
      )
      // Socket inactivity — covers both connect and mid-body stalls.
      req.setTimeout(STALL_MS, () => req.destroy(new EngineError('connection stalled', 'transient')))
      req.on('error', (e) => reject(toEngineError(e)))
      req.end()
    })
  }

  /**
   * GET a whole (small) resource into memory: playlists, keys, HLS segments.
   * Returns the final URL after redirects (relative URIs resolve against it).
   * `track` receives the request so the caller can abort it.
   */
  async getBuffer(
    url: string,
    opts: { range?: { offset: number; length: number }; maxBytes?: number; track?: (req: ClientRequest | null) => void } = {}
  ): Promise<{ body: Buffer; url: string }> {
    const { range, maxBytes = 256 * 1024 * 1024, track } = opts
    const header = range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : null
    const { res, req, url: finalUrl } = await this.open(url, header)
    track?.(req)
    try {
      const status = res.statusCode ?? 0
      if (status !== 200 && status !== 206) {
        res.resume()
        throw httpError(status, res.headers['retry-after'] as string | undefined)
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of res as AsyncIterable<Buffer>) {
        chunks.push(chunk)
        size += chunk.length
        if (size > maxBytes) throw new EngineError('response too large', 'fallback')
      }
      if (!res.complete) throw new EngineError('connection closed early', 'transient')
      let body = Buffer.concat(chunks)
      // Server ignored the Range header: cut our slice out of the whole file.
      if (range && status === 200) body = body.subarray(range.offset, range.offset + range.length)
      return { body, url: finalUrl }
    } finally {
      if (!res.complete) req.destroy()
      track?.(null)
    }
  }
}
