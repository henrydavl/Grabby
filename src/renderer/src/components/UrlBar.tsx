import { useEffect, useState } from 'react'
import type { FormatKind, MediaInfo } from '../../../shared/types'
import { FormatPicker } from './FormatPicker'

export function UrlBar(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<MediaInfo | null>(null)
  // Referer to attach when the resolved source is a sniffed stream URL.
  const [referer, setReferer] = useState<string | undefined>(undefined)

  const fetch = async (target?: string): Promise<void> => {
    const trimmed = (target ?? url).trim()
    if (!trimmed) return
    setUrl(trimmed)
    setReferer(undefined)
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

  // Requests pushed from the browser extension: try each candidate (page URL
  // first, then sniffed streams) until one yields formats.
  useEffect(() => {
    return window.grabby.onExternalRequest(async ({ candidates }) => {
      setUrl(candidates[0]?.url ?? '')
      setLoading(true)
      setError(null)
      setReferer(undefined)
      let lastErr: unknown = null
      for (const candidate of candidates) {
        try {
          const result = await window.grabby.fetchInfo(candidate.url, candidate.referer)
          setUrl(candidate.url)
          setReferer(candidate.referer)
          setInfo(result)
          setLoading(false)
          return
        } catch (e) {
          lastErr = e
        }
      }
      setError(lastErr instanceof Error ? lastErr.message : 'Could not read that video.')
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirm = async (format: FormatKind, label: string): Promise<void> => {
    if (!info) return
    const specs =
      info.isPlaylist && info.entries
        ? info.entries.map((e) => ({ url: e.url, title: e.title, format, formatLabel: label, referer }))
        : [{ url: info.url, title: info.title, format, formatLabel: label, referer }]
    await window.grabby.addDownloads(specs)
    setInfo(null)
    setUrl('')
    setReferer(undefined)
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
