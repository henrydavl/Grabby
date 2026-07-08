import { createWriteStream, existsSync, unlink } from 'fs'
import { join } from 'path'
import { get as httpGet } from 'http'
import { get as httpsGet, RequestOptions } from 'https'
import { URL } from 'url'
import { sanitizeName } from './ytdlp'
import type { ProgressUpdate } from '../shared/types'
import type { DownloadResult } from './ytdlp'

// A plain browser-ish UA + Accept so subtitle CDNs (some behind light bot checks)
// don't refuse us. Subtitle files are small static text — no impersonation needed.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * IDM-style duplicate handling for a subtitle file: if "<base>.<ext>" exists,
 * bump to "<base> (1).<ext>", etc. Returns the full destination path.
 */
export function resolveSubtitlePath(outputDir: string, rawName: string, ext: string): string {
  const base = sanitizeName(rawName)
  if (!existsSync(join(outputDir, `${base}.${ext}`))) return join(outputDir, `${base}.${ext}`)
  let n = 1
  while (existsSync(join(outputDir, `${base} (${n}).${ext}`))) n++
  return join(outputDir, `${base} (${n}).${ext}`)
}

/** Guess a subtitle extension from a URL, defaulting to srt. */
export function subtitleExtFromUrl(url: string): string {
  const path = url.split('?')[0].toLowerCase()
  const m = path.match(/\.(srt|vtt|ass|ssa|sub|smi|ttml|dfxp)$/)
  return m ? m[1] : 'srt'
}

interface SubHandle {
  /** Abort the in-flight download (used by cancel/remove). */
  abort: () => void
  done: Promise<DownloadResult>
}

/**
 * Download a subtitle file over HTTP(S) to destPath, following redirects and
 * sending a Referer so referer-gated CDNs serve it. Reports a simple byte-based
 * progress. Returns a handle whose `done` resolves like a yt-dlp download.
 */
export function startSubtitleDownload(opts: {
  id: string
  url: string
  destPath: string
  referer?: string
  onProgress: (p: ProgressUpdate) => void
}): SubHandle {
  const { id, url, destPath, referer, onProgress } = opts
  let aborted = false
  let currentAbort: (() => void) | null = null

  const fmt = (n: number): string => {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MiB`
    if (n >= 1024) return `${(n / 1024).toFixed(0)}KiB`
    return `${n}B`
  }

  const done = new Promise<DownloadResult>((resolve) => {
    const fail = (msg: string): void => resolve({ code: 1, error: msg })

    const request = (target: string, redirects: number): void => {
      if (aborted) return
      if (redirects > 5) return fail('too many redirects')
      let parsed: URL
      try {
        parsed = new URL(target)
      } catch {
        return fail('invalid subtitle URL')
      }
      const getter = parsed.protocol === 'http:' ? httpGet : httpsGet
      const options: RequestOptions = {
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          ...(referer ? { Referer: referer } : {})
        }
      }
      const req = getter(parsed, options, (res) => {
        const status = res.statusCode || 0
        // Follow redirects.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          const next = new URL(res.headers.location, parsed).toString()
          return request(next, redirects + 1)
        }
        if (status !== 200) {
          res.resume()
          return fail(`server responded ${status}`)
        }

        const total = parseInt(res.headers['content-length'] || '0', 10) || 0
        let received = 0
        const file = createWriteStream(destPath)
        currentAbort = (): void => {
          req.destroy()
          res.destroy()
          file.destroy()
          unlink(destPath, () => {})
        }

        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          const percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0
          onProgress({
            id,
            percent,
            speed: '',
            eta: '',
            downloaded: fmt(received),
            total: total ? fmt(total) : ''
          })
        })
        res.pipe(file)
        file.on('finish', () => {
          file.close(() => {
            if (aborted) return
            onProgress({ id, percent: 100, speed: '', eta: '', downloaded: fmt(received), total: total ? fmt(total) : fmt(received) })
            resolve({ code: 0, filePath: destPath })
          })
        })
        file.on('error', (e) => {
          unlink(destPath, () => {})
          fail(e.message)
        })
      })
      req.on('error', (e) => {
        if (!aborted) fail(e.message)
      })
      req.setTimeout(30_000, () => {
        req.destroy()
        if (!aborted) fail('subtitle download timed out')
      })
    }

    request(url, 0)
  })

  return {
    abort: (): void => {
      aborted = true
      currentAbort?.()
    },
    done
  }
}
