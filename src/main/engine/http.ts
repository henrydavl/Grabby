import { request as httpRequest, Agent as HttpAgent, type ClientRequest, type IncomingMessage } from 'http'
import { request as httpsRequest, Agent as HttpsAgent } from 'https'
import type { HttpHeaders } from '../../shared/types'
import { EngineError, httpError, toEngineError } from './errors'

const STALL_MS = 20_000 // no bytes for this long = dead connection
const MAX_REDIRECTS = 5

// Browser credentials are only ever sent to the host they were captured for —
// never to redirect targets or other CDN hosts (as a browser would behave).
const SCOPED_HEADERS = new Set(['cookie', 'authorization'])

/** Hostname of a URL, or null if it doesn't parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/** Keep-alive HTTP(S) client shared by one download's connections. */
export class HttpClient {
  private readonly httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 32 })
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32 })

  /**
   * @param credentialHost host the Cookie/Authorization headers belong to; they
   *   are dropped for every other host (null: never send them).
   */
  constructor(
    private readonly headers: HttpHeaders,
    private readonly credentialHost: string | null
  ) {}

  destroy(): void {
    this.httpAgent.destroy()
    this.httpsAgent.destroy()
  }

  private headersFor(u: URL, range: string | null): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(this.headers)) {
      const lower = name.toLowerCase()
      if (lower === 'host' || lower === 'accept-encoding' || lower === 'range') continue
      if (SCOPED_HEADERS.has(lower) && u.hostname !== this.credentialHost) continue
      out[name] = value
    }
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
