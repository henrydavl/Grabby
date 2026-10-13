// Which downloader handles a resolved download. yt-dlp always does the
// extraction; Grabby's engines do the transfer when the formats are ones they
// handle at least as well as yt-dlp.

export interface ResolvedFormat {
  url: string
  protocol: string
  ext: string
  httpHeaders?: Record<string, string>
  /** yt-dlp's scoped cookie string for this format ("a=1; Domain=…; Path=/"). */
  cookies?: string
  /** Needs curl_cffi browser impersonation (TLS fingerprint) to be served. */
  impersonate?: boolean
  /** yt-dlp downloads it in fixed-size chunks (hosts that throttle big ranges). */
  chunked?: boolean
  /** Comes as a list of fragments (DASH segments etc.). */
  fragmented?: boolean
}

export type Route =
  | { kind: 'http' | 'hls'; formats: ResolvedFormat[] }
  | { kind: 'ytdlp'; reason: string }

const ytdlp = (reason: string): Route => ({ kind: 'ytdlp', reason })

export function isYouTubeUrl(url: string): boolean {
  try {
    return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

export function routeFor(extractor: string, formats: ResolvedFormat[]): Route {
  // Already at line speed via yt-dlp, and googlevideo has its own range rules.
  if (/^youtube/i.test(extractor)) return ytdlp('YouTube')
  if (formats.length === 0) return ytdlp('no direct formats')
  if (formats.some((f) => f.impersonate)) return ytdlp('needs browser impersonation')
  if (formats.some((f) => f.chunked)) return ytdlp('host needs chunked downloads')
  if (formats.some((f) => f.fragmented)) return ytdlp('fragmented format')
  if (formats.every((f) => f.protocol === 'http' || f.protocol === 'https')) return { kind: 'http', formats }
  if (formats.every((f) => f.protocol.startsWith('m3u8'))) return { kind: 'hls', formats }
  return ytdlp(`protocol ${formats.map((f) => f.protocol).join('+')}`)
}
