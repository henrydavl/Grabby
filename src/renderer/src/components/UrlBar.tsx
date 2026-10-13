import { useEffect, useState } from 'react'
import type {
  DownloadCandidate,
  DownloadSpec,
  FormatKind,
  MediaInfo,
  SubtitleCandidate
} from '../../../shared/types'
import { FormatPicker } from './FormatPicker'

/** Build a DownloadSpec for a sniffed subtitle file. */
function subSpec(sub: SubtitleCandidate, baseTitle?: string): DownloadSpec {
  const ext =
    sub.ext || (sub.url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? 'srt').toLowerCase()
  // Name it after the video when we know it (…/Title.English.srt), else the label
  // or the URL's own filename.
  const base = baseTitle
    ? `${baseTitle}${sub.label ? '.' + sub.label : ''}`
    : sub.label || decodeURIComponent(sub.url.split('?')[0].split('/').pop() || 'subtitle')
  return {
    url: sub.url,
    title: base.replace(/\.[a-z0-9]+$/i, ''),
    format: 'best',
    formatLabel: sub.label || 'Subtitle',
    referer: sub.referer,
    headers: sub.headers,
    kind: 'subtitle',
    subExt: ext
  }
}

// yt-dlp probes run in parallel, but each is a full Python process, so cap them.
const PROBE_CONCURRENCY = 3

/**
 * Probe candidates with yt-dlp a few at a time and return the highest-priority
 * one that resolves: a slow or failing page URL no longer holds up a working
 * sniffed stream, yet a working page URL (best quality via site extractors)
 * still wins over the streams behind it.
 */
async function probeInOrder(
  candidates: DownloadCandidate[]
): Promise<{ candidate: DownloadCandidate; info: MediaInfo }> {
  const deferred = candidates.map(() => {
    let resolve!: (info: MediaInfo) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<MediaInfo>((res, rej) => ((resolve = res), (reject = rej)))
    promise.catch(() => {}) // results we stop waiting for must not surface as unhandled
    return { promise, resolve, reject }
  })
  let next = 0
  let found = false
  const worker = async (): Promise<void> => {
    while (!found && next < candidates.length) {
      const i = next++
      const c = candidates[i]
      try {
        deferred[i].resolve(await window.grabby.fetchInfo(c.url, c.referer, c.headers))
      } catch (e) {
        deferred[i].reject(e)
      }
    }
  }
  for (let w = 0; w < Math.min(PROBE_CONCURRENCY, candidates.length); w++) void worker()

  let lastErr: unknown = new Error('Nothing to download on this page.')
  for (let i = 0; i < candidates.length; i++) {
    try {
      const info = await deferred[i].promise
      found = true
      return { candidate: candidates[i], info }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

export function UrlBar(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<MediaInfo | null>(null)
  // Referer + browser headers to attach when the resolved source is a sniffed stream URL.
  const [source, setSource] = useState<Omit<DownloadCandidate, 'url'>>({})
  // Subtitles sniffed alongside a "video + subtitle" request, queued once the
  // user confirms a video quality (so they can be named after the video).
  const [pendingSubs, setPendingSubs] = useState<SubtitleCandidate[]>([])

  const fetch = async (target?: string): Promise<void> => {
    const trimmed = (target ?? url).trim()
    if (!trimmed) return
    setUrl(trimmed)
    setSource({})
    setLoading(true)
    setError(null)
    try {
      const result = await window.grabby.fetchInfo(trimmed)
      setInfo(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that link.')
    } finally {
      setLoading(false)
    }
  }

  // Requests pushed from the browser extension. Depending on the dropdown choice:
  //  - 'subtitle': queue the sniffed subtitle file(s) directly, no picker.
  //  - 'video'/'both': try each candidate (page URL first, then sniffed streams)
  //    until one yields formats, then show the quality picker. For 'both' the
  //    subtitles are held until the user confirms so they're named after the video.
  useEffect(() => {
    return window.grabby.onExternalRequest(async ({ candidates, subtitles, kind, drm }) => {
      const subs = subtitles ?? []
      if (kind === 'subtitle') {
        if (subs.length > 0) await window.grabby.addDownloads(subs.map((s) => subSpec(s)))
        return
      }
      setPendingSubs(kind === 'both' ? subs : [])
      setUrl(candidates[0]?.url ?? '')
      setLoading(true)
      setError(null)
      setSource({})
      try {
        const { candidate, info: result } = await probeInOrder(candidates)
        setUrl(candidate.url)
        setSource({ referer: candidate.referer, headers: candidate.headers })
        setInfo(result)
      } catch (e) {
        // The page played DRM-protected media and nothing else resolved: say so
        // plainly instead of showing yt-dlp's last (misleading) error.
        setError(
          drm
            ? `This video is DRM-protected (${drm}), so it can't be downloaded.`
            : e instanceof Error
              ? e.message
              : 'Could not read that video.'
        )
      }
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirm = async (format: FormatKind, label: string): Promise<void> => {
    if (!info) return
    const specs: DownloadSpec[] =
      info.isPlaylist && info.entries
        ? info.entries.map((e) => ({
            url: e.url,
            title: e.title,
            format,
            formatLabel: label,
            referer: source.referer
          }))
        : [
            {
              url: info.url,
              title: info.title,
              format,
              formatLabel: label,
              ...source,
              direct: info.direct
            }
          ]
    // Queue any "video + subtitle" subs, named after the (single) video.
    for (const s of pendingSubs) {
      specs.push(subSpec(s, info.isPlaylist ? undefined : info.title))
    }
    await window.grabby.addDownloads(specs)
    setInfo(null)
    setUrl('')
    setSource({})
    setPendingSubs([])
  }

  return (
    <div className="no-drag">
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && fetch()}
          placeholder="Paste a video or playlist link…"
          className="flex-1 rounded-lg border border-edge bg-ink px-3 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-accent"
        />
        <button
          onClick={() => fetch()}
          disabled={loading || !url.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-40"
        >
          {loading ? 'Reading…' : 'Add'}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red-400">{error}</div>}

      {info && (
        <FormatPicker info={info} onConfirm={confirm} onCancel={() => setInfo(null)} />
      )}
    </div>
  )
}
