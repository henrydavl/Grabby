// Shared types used across main, preload, and renderer.

export type DownloadStatus =
  | 'queued'
  | 'fetching'
  | 'preparing'
  | 'downloading'
  | 'retrying' // failed with a transient error; waiting to auto-retry
  | 'paused'
  | 'completed'
  | 'error'
  | 'canceled'

/** A user-facing quality choice that maps to a yt-dlp format selector. */
export type FormatKind = 'best' | '2160' | '1440' | '1080' | '720' | '480' | 'audio'

/** How many times a download is automatically re-run after a transient failure. */
export const MAX_AUTO_RETRIES = 8

export interface FormatOption {
  kind: FormatKind
  label: string // e.g. "1080p", "Audio only (mp3)"
}

/**
 * A single plain HTTP(S) media file (yt-dlp's generic extractor found exactly
 * one progressive format). Grabby's own multi-connection engine downloads these.
 */
export interface DirectSource {
  url: string
  /** Headers yt-dlp would send (its UA, plus any --add-header/--referer). */
  headers?: HttpHeaders
  ext: string
}

/** Metadata returned by `yt-dlp -J`. */
export interface MediaInfo {
  url: string
  title: string
  thumbnail?: string
  durationString?: string
  isPlaylist: boolean
  /** For playlists: the individual entries (each becomes its own download item). */
  entries?: { url: string; title: string }[]
  /** Heights available for a single video, used to filter the quality picker. */
  availableHeights?: number[]
  /** Estimated total bytes (video+audio) per resolution height. */
  sizeByHeight?: Record<number, number>
  /** Estimated bytes for the "Best available" selection. */
  bestSize?: number
  /** Estimated bytes for the audio-only selection. */
  audioSize?: number
  /** Set when this is one plain file the segmented engine can fetch. */
  direct?: DirectSource
  /** HLS from the generic extractor: Grabby's HLS engine downloads the variant yt-dlp picks. */
  hls?: boolean
}

/** Request headers captured from the browser's own request for a stream (name → value). */
export type HttpHeaders = Record<string, string>

export interface ProgressUpdate {
  id: string
  percent: number // 0..100
  speed: string // e.g. "4.21MiB/s"
  eta: string // e.g. "00:42"
  downloaded: string // e.g. "45.2MiB" (current stream)
  total: string // e.g. "142MiB" (current stream; "" if unknown)
  /** Parallel connections in use (Grabby's engine only). */
  connections?: number
}

export interface DownloadItem {
  id: string
  url: string
  title: string
  thumbnail?: string
  format: FormatKind
  formatLabel: string
  status: DownloadStatus
  percent: number
  speed: string
  eta: string
  downloaded?: string
  total?: string
  outputDir: string
  outputBase?: string // resolved non-clobbering filename stem (no extension)
  filePath?: string // resolved final path once known
  referer?: string // page URL, needed for sniffed stream downloads
  headers?: HttpHeaders // browser request headers for sniffed streams (cookies etc.)
  error?: string
  /** Automatic retries used so far (reset when a retry makes progress). */
  attempt?: number
  /** Epoch ms of the next automatic retry while status === 'retrying'. */
  retryAt?: number
  /** Transient hint shown while downloading, e.g. "Connection lost — retrying (2)". */
  notice?: string
  /** Plain-file source for Grabby's segmented engine (see DirectSource). */
  direct?: DirectSource
  /** Download with Grabby's HLS engine (see MediaInfo.hls). */
  hls?: boolean
  /** The engine couldn't fetch it (blocked, not a file…): use yt-dlp from now on. */
  useYtdlp?: boolean
  /** Parallel connections in use (Grabby's engine only). */
  connections?: number
  /** 'video' (yt-dlp) or 'subtitle' (direct file download). Defaults to 'video'. */
  kind?: 'video' | 'subtitle'
  subExt?: string // subtitle file extension (srt/vtt/…) when kind === 'subtitle'
}

/** One thing to try: a URL plus the Referer it should be fetched with. */
export interface DownloadCandidate {
  url: string
  referer?: string
  /** Headers the browser sent for this URL; replayed so token/cookie-gated CDNs accept us. */
  headers?: HttpHeaders
}

/** A subtitle file the extension sniffed from network traffic. */
export interface SubtitleCandidate {
  url: string
  referer?: string
  /** e.g. "English", "Arabic" — best-effort, derived from filename/lang. */
  label?: string
  /** File extension without the dot, e.g. "srt", "vtt". */
  ext?: string
  headers?: HttpHeaders
}

/** A download request pushed from the browser extension via the bridge. */
export interface ExternalRequest {
  /** Tried in order: the page URL first, then any sniffed stream URLs. */
  candidates: DownloadCandidate[]
  /** Sniffed subtitle files, if any (offered via the button's dropdown). */
  subtitles?: SubtitleCandidate[]
  /** What the user chose in the dropdown. 'video' (default), 'subtitle', or 'both'. */
  kind?: 'video' | 'subtitle' | 'both'
  /** EME key system (e.g. "com.widevine.alpha") if the page played DRM-protected media. */
  drm?: string
}

/** Browser yt-dlp pulls cookies from, to satisfy YouTube's bot check. */
export type CookiesBrowser =
  | 'none'
  | 'safari'
  | 'chrome'
  | 'firefox'
  | 'zen'
  | 'brave'
  | 'edge'
  | 'chromium'
  | 'opera'
  | 'vivaldi'

export interface AppSettings {
  outputDir: string
  maxConcurrent: number
  cookiesBrowser: CookiesBrowser
  /** Parallel connections per download for Grabby's engine (1–16). */
  connections: number
}

/** The typed API the preload bridge exposes to the renderer as `window.grabby`. */
export interface DownloadSpec {
  url: string
  title: string
  format: FormatKind
  formatLabel: string
  referer?: string
  headers?: HttpHeaders
  direct?: DirectSource
  hls?: boolean
  /** 'subtitle' downloads the URL as a plain file instead of via yt-dlp. */
  kind?: 'video' | 'subtitle'
  subExt?: string // subtitle extension (srt/vtt/…) when kind === 'subtitle'
}

export interface GrabbyAPI {
  fetchInfo: (url: string, referer?: string, headers?: HttpHeaders) => Promise<MediaInfo>
  addDownloads: (items: DownloadSpec[]) => Promise<DownloadItem[]>
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  revealInFinder: (id: string) => Promise<void>
  getItems: () => Promise<DownloadItem[]>
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>
  chooseOutputDir: () => Promise<string | null>
  updateYtdlp: () => Promise<{ ok: boolean; message: string }>
  onProgress: (cb: (p: ProgressUpdate) => void) => () => void
  onItemUpdate: (cb: (item: DownloadItem) => void) => () => void
  onItemRemoved: (cb: (id: string) => void) => () => void
  onExternalRequest: (cb: (req: ExternalRequest) => void) => () => void
}
