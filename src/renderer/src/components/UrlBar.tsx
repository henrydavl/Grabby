import { useEffect, useRef, useState } from 'react'
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

/** A candidate that yt-dlp could read; `index` is its priority (0 = page URL). */
interface Source {
  index: number
  candidate: DownloadCandidate
  info: MediaInfo
}

/**
 * Probe candidates with yt-dlp a few at a time. Resolves with the
 * highest-priority one that works — a slow or failing page URL doesn't hold up a
 * working sniffed stream, yet a working page URL (best quality via site
 * extractors) still wins. The rest keep probing in the background and are
 * reported via onFound, so the source picker can offer them (IDM-style).
 */
async function probe(candidates: DownloadCandidate[], onFound: (s: Source) => void): Promise<Source> {
  const deferred = candidates.map(() => {
    let resolve!: (s: Source) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<Source>((res, rej) => ((resolve = res), (reject = rej)))
    promise.catch(() => {}) // results nobody awaits must not surface as unhandled
    return { promise, resolve, reject }
  })
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const index = next++
      const candidate = candidates[index]
      try {
        const info = await window.grabby.fetchInfo(candidate.url, candidate.referer, candidate.headers)
        const source = { index, candidate, info }
        onFound(source)
        deferred[index].resolve(source)
      } catch (e) {
        deferred[index].reject(e)
      }
    }
  }
  for (let w = 0; w < Math.min(PROBE_CONCURRENCY, candidates.length); w++) void worker()

  let lastErr: unknown = new Error('Nothing to download on this page.')
  for (const d of deferred) {
    try {
      return await d.promise
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** "This page (Vimeo) · 1080p · 12:31" or "cdn.example.com · HLS · 720p · 12:31". */
function sourceLabel(s: Source, page: string | undefined): string {
  const { info } = s
  const parts = [
    s.candidate.url === page
      ? `This page${info.extractor && info.extractor !== 'Generic' ? ` (${info.extractor})` : ''}`
      : hostOf(s.candidate.url)
  ]
  if (info.isPlaylist) {
    parts.push(`playlist of ${info.entries?.length ?? 0}`)
  } else {
    if (info.streamType) parts.push(info.streamType)
    if (info.availableHeights?.[0]) parts.push(`${info.availableHeights[0]}p`)
    if (info.durationString) parts.push(info.durationString)
  }
  return parts.join(' · ')
}

export function UrlBar(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<MediaInfo | null>(null)
  // Referer + browser headers to attach when the resolved source is a sniffed
  // stream URL, plus the page it came from (lets a later click refresh it).
  const [source, setSource] = useState<Omit<DownloadCandidate, 'url'> & { page?: string }>({})
  // Every candidate of the current extension request that yt-dlp could read.
  const [sources, setSources] = useState<Source[]>([])
  const [selected, setSelected] = useState(0)
  const [page, setPage] = useState<string | undefined>(undefined)
  // Late probe results from an older request must not leak into a newer one.
  const requestId = useRef(0)
  // Subtitles sniffed alongside a "video + subtitle" request, queued once the
  // user confirms a video quality (so they can be named after the video).
  const [pendingSubs, setPendingSubs] = useState<SubtitleCandidate[]>([])

  const fetch = async (target?: string): Promise<void> => {
    const trimmed = (target ?? url).trim()
    if (!trimmed) return
    requestId.current++
    setUrl(trimmed)
    setSource({})
    setSources([])
    setPage(undefined)
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
      const id = ++requestId.current
      const pageUrl = candidates[0]?.url
      setPendingSubs(kind === 'both' ? subs : [])
      setUrl(pageUrl ?? '')
      setPage(pageUrl)
      setLoading(true)
      setError(null)
      setSource({})
      setSources([])
      try {
        const best = await probe(candidates, (found) => {
          if (requestId.current !== id) return
          setSources((prev) => [...prev, found].sort((a, b) => a.index - b.index))
        })
        if (requestId.current !== id) return
        choose(best, pageUrl)
      } catch (e) {
        if (requestId.current !== id) return
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

  const choose = (s: Source, pageUrl: string | undefined): void => {
    setSelected(s.index)
    setUrl(s.candidate.url)
    setSource({ referer: s.candidate.referer, headers: s.candidate.headers, page: pageUrl })
    setInfo(s.info)
  }

  const close = (): void => {
    requestId.current++
    setInfo(null)
    setSources([])
  }

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
              ...source
            }
          ]
    // Queue any "video + subtitle" subs, named after the (single) video.
    for (const s of pendingSubs) {
      specs.push(subSpec(s, info.isPlaylist ? undefined : info.title))
    }
    await window.grabby.addDownloads(specs)
    close()
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
        <FormatPicker
          key={selected}
          info={info}
          onConfirm={confirm}
          onCancel={close}
          sourcePicker={
            sources.length > 1 && (
              <div className="mt-4">
                <label htmlFor="grabby-source" className="block text-xs text-slate-400">
                  Source{' '}
                  <span className="text-slate-500">({sources.length} found on this page)</span>
                </label>
                <select
                  id="grabby-source"
                  value={selected}
                  onChange={(e) => {
                    const s = sources.find((x) => x.index === Number(e.target.value))
                    if (s) choose(s, page)
                  }}
                  className="mt-1 w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-slate-200 outline-none focus:border-accent"
                >
                  {sources.map((s) => (
                    <option key={s.index} value={s.index}>
                      {sourceLabel(s, page)}
                    </option>
                  ))}
                </select>
              </div>
            )
          }
        />
      )}
    </div>
  )
}
