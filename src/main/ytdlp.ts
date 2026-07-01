import { spawn, execFile, ChildProcess } from 'child_process'
import { existsSync, chmodSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app } from 'electron'
import type { CookiesBrowser, FormatKind, MediaInfo, ProgressUpdate } from '../shared/types'

/**
 * Resolve the directory that holds the bundled binaries.
 * - Packaged: process.resourcesPath/bin/<platform>
 * - Dev:      <projectRoot>/resources/bin/<platform>
 */
function binDir(): string {
  const platform = process.platform === 'win32' ? 'win' : 'mac'
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', platform)
  }
  // In dev, __dirname is out/main; project root is two levels up.
  return join(app.getAppPath(), 'resources', 'bin', platform)
}

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)

let cachedYtdlp: string | null = null
let cachedFfmpegDir: string | null = null

/** Path to the yt-dlp binary; falls back to a PATH lookup if the bundle is missing. */
export function ytdlpPath(): string {
  if (cachedYtdlp) return cachedYtdlp
  const bundled = join(binDir(), exe('yt-dlp'))
  if (existsSync(bundled)) {
    try {
      chmodSync(bundled, 0o755)
    } catch {
      /* best effort */
    }
    cachedYtdlp = bundled
  } else {
    cachedYtdlp = exe('yt-dlp') // rely on PATH
  }
  return cachedYtdlp
}

/**
 * Directory containing ffmpeg, passed to yt-dlp via --ffmpeg-location.
 * Prefers the bundled binary, then common system locations.
 */
export function ffmpegDir(): string | null {
  if (cachedFfmpegDir !== null) return cachedFfmpegDir
  const bundled = join(binDir(), exe('ffmpeg'))
  if (existsSync(bundled)) {
    try {
      chmodSync(bundled, 0o755)
    } catch {
      /* best effort */
    }
    cachedFfmpegDir = binDir()
    return cachedFfmpegDir
  }
  const candidates =
    process.platform === 'win32'
      ? []
      : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedFfmpegDir = c.replace(/\/ffmpeg$/, '')
      return cachedFfmpegDir
    }
  }
  cachedFfmpegDir = ''
  return null
}

/** Map a user-facing quality choice to yt-dlp arguments. */
export function formatArgs(kind: FormatKind): string[] {
  const merge = ['--merge-output-format', 'mp4']
  switch (kind) {
    case 'audio':
      return ['-x', '--audio-format', 'mp3', '--audio-quality', '0']
    case 'best':
      return ['-f', 'bv*+ba/b', ...merge]
    default: {
      const h = kind // '2160' | '1440' | '1080' | '720' | '480'
      return ['-f', `bv*[height<=${h}]+ba/b[height<=${h}]`, ...merge]
    }
  }
}

function ffmpegArgs(): string[] {
  const dir = ffmpegDir()
  return dir ? ['--ffmpeg-location', dir] : []
}

/** Make a title safe to use as a filename (strip only FS-illegal chars). */
function sanitizeName(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || 'video'
  )
}

/**
 * IDM-style duplicate handling: if "<title>.<ext>" already exists in the output
 * folder, return "<title> (1)", "<title> (2)", … so re-downloads don't overwrite.
 * Returns the filename stem (no extension); yt-dlp fills the real extension.
 */
export function resolveOutputBase(outputDir: string, title: string, format: FormatKind): string {
  const ext = format === 'audio' ? 'mp3' : 'mp4'
  const base = sanitizeName(title)
  if (!existsSync(join(outputDir, `${base}.${ext}`))) return base
  let n = 1
  while (existsSync(join(outputDir, `${base} (${n}).${ext}`))) n++
  return `${base} (${n})`
}

// The browser whose cookies yt-dlp should reuse (set from settings). Needed for
// YouTube, which otherwise rejects requests with a "confirm you're not a bot" error.
let cookiesBrowser: CookiesBrowser = 'none'

export function setCookiesBrowser(browser: CookiesBrowser): void {
  cookiesBrowser = browser
}

/**
 * Zen is a Firefox fork; yt-dlp doesn't know it by name, but it can read a Firefox
 * cookie store from an explicit profile path. Find the Zen profile whose
 * cookies.sqlite was most recently modified (the one actually in use).
 */
function zenProfileDir(): string | null {
  const roots =
    process.platform === 'win32'
      ? [join(process.env.APPDATA || '', 'zen', 'Profiles')]
      : [join(homedir(), 'Library', 'Application Support', 'zen', 'Profiles')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    let best: { dir: string; mtime: number } | null = null
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      const cookies = join(dir, 'cookies.sqlite')
      if (!existsSync(cookies)) continue
      const mtime = statSync(cookies).mtimeMs
      if (!best || mtime > best.mtime) best = { dir, mtime }
    }
    if (best) return best.dir
  }
  return null
}

function cookieArgs(): string[] {
  if (!cookiesBrowser || cookiesBrowser === 'none') return []
  if (cookiesBrowser === 'zen') {
    const profile = zenProfileDir()
    // yt-dlp format: firefox:<profile path> (Zen uses the Firefox cookie format).
    return profile ? ['--cookies-from-browser', `firefox:${profile}`] : []
  }
  return ['--cookies-from-browser', cookiesBrowser]
}

/**
 * Environment for spawned yt-dlp processes. A GUI app launched from Finder gets a
 * minimal PATH that usually omits Homebrew, so yt-dlp can't find its JS runtime
 * (deno) — which YouTube now requires to solve signature challenges. Prepend the
 * bundled bin dir plus common Homebrew/system locations so deno + ffmpeg resolve.
 */
function spawnEnv(): NodeJS.ProcessEnv {
  const sep = process.platform === 'win32' ? ';' : ':'
  // The bundled bin dir always goes first (holds deno/ffmpeg); the extra Unix
  // locations only make sense off-Windows.
  const extra =
    process.platform === 'win32'
      ? [binDir()]
      : [binDir(), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
  const existing = process.env.PATH ? process.env.PATH.split(sep) : []
  const merged = [...extra, ...existing].filter((p, i, a) => p && a.indexOf(p) === i)
  return { ...process.env, PATH: merged.join(sep) }
}

/** Run yt-dlp and collect stdout (used for JSON info dumps and `-U`). */
function run(args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      ytdlpPath(),
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, env: spawnEnv() },
      (err, stdout, stderr) => {
        // A non-zero exit is a real failure even when yt-dlp printed something
        // (e.g. it writes a bare "null" to stdout on extractor errors). Surface
        // the most meaningful stderr line so the user sees the actual cause.
        if (err) {
          const lines = (stderr || '').split('\n').filter(Boolean)
          const msg = lines[lines.length - 1] || err.message
          reject(new Error(msg))
        } else {
          resolve({ stdout, stderr })
        }
      }
    )
  })
}

interface RawInfo {
  _type?: string
  title?: string
  thumbnail?: string
  duration_string?: string
  webpage_url?: string
  entries?: { url?: string; webpage_url?: string; title?: string; id?: string }[]
  duration?: number | null
  formats?: RawFormat[]
}

interface RawFormat {
  height?: number | null
  vcodec?: string | null
  acodec?: string | null
  filesize?: number | null
  filesize_approx?: number | null
  tbr?: number | null // total bitrate, kbps
  abr?: number | null // audio bitrate, kbps
}

/** Best available byte estimate for a single format. */
function formatBytes(f: RawFormat, duration?: number | null): number {
  if (f.filesize) return f.filesize
  if (f.filesize_approx) return f.filesize_approx
  if (f.tbr && duration) return Math.round((f.tbr * 1000 * duration) / 8)
  return 0
}

/** Compute estimated combined (video+audio) size per height, plus best/audio. */
function computeSizes(formats: RawFormat[], duration?: number | null): {
  sizeByHeight: Record<number, number>
  bestSize: number
  audioSize: number
} {
  const isAudioOnly = (f: RawFormat): boolean =>
    (!f.vcodec || f.vcodec === 'none') && !!f.acodec && f.acodec !== 'none'
  const hasVideo = (f: RawFormat): boolean => !!f.vcodec && f.vcodec !== 'none'

  // Best audio = highest bitrate audio-only stream (what yt-dlp would merge in).
  let bestAudio: RawFormat | null = null
  for (const f of formats) {
    if (!isAudioOnly(f)) continue
    if (!bestAudio || (f.abr || f.tbr || 0) > (bestAudio.abr || bestAudio.tbr || 0)) bestAudio = f
  }
  const audioSize = bestAudio ? formatBytes(bestAudio, duration) : 0

  const sizeByHeight: Record<number, number> = {}
  for (const f of formats) {
    if (!hasVideo(f) || !f.height) continue
    const vBytes = formatBytes(f, duration)
    if (!vBytes) continue
    const combined = f.acodec && f.acodec !== 'none' ? vBytes : vBytes + audioSize
    // Keep the largest estimate per height (best variant at that resolution).
    if (!sizeByHeight[f.height] || combined > sizeByHeight[f.height]) sizeByHeight[f.height] = combined
  }

  const maxH = Object.keys(sizeByHeight)
    .map(Number)
    .sort((a, b) => b - a)[0]
  return { sizeByHeight, bestSize: maxH ? sizeByHeight[maxH] : 0, audioSize }
}

function refererArgs(referer?: string): string[] {
  return referer ? ['--referer', referer] : []
}

// Many embed hosts (Doodstream/playmogo, StreamTape, etc.) sit behind Cloudflare's
// anti-bot, which 403s yt-dlp's default client. Impersonating a real browser's TLS
// fingerprint (via the bundled curl_cffi) gets past it. Scoped to the generic
// extractor so it doesn't change behavior for sites with dedicated extractors.
const IMPERSONATE_ARGS = ['--extractor-args', 'generic:impersonate']

/** Fetch metadata + available formats for a URL (single video or playlist). */
export async function fetchInfo(url: string, referer?: string): Promise<MediaInfo> {
  // First pass: flat dump so playlists are cheap to detect.
  const { stdout } = await run([
    '-J',
    '--flat-playlist',
    '--no-warnings',
    ...cookieArgs(),
    ...refererArgs(referer),
    ...IMPERSONATE_ARGS,
    url
  ])
  const info = JSON.parse(stdout) as RawInfo

  if (info._type === 'playlist' && info.entries) {
    return {
      url,
      title: info.title || 'Playlist',
      thumbnail: info.thumbnail,
      isPlaylist: true,
      entries: info.entries.map((e) => ({
        url: e.url || e.webpage_url || e.id || '',
        title: e.title || 'Untitled'
      }))
    }
  }

  const formats = info.formats || []
  const heights = Array.from(
    new Set(formats.map((f) => f.height).filter((h): h is number => !!h))
  ).sort((a, b) => b - a)
  const { sizeByHeight, bestSize, audioSize } = computeSizes(formats, info.duration)

  return {
    url: info.webpage_url || url,
    title: info.title || url,
    thumbnail: info.thumbnail,
    durationString: info.duration_string,
    isPlaylist: false,
    availableHeights: heights,
    sizeByHeight,
    bestSize,
    audioSize
  }
}

const PROGRESS_TEMPLATE =
  'download:GBY|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s' +
  '|%(progress._downloaded_bytes_str)s|%(progress._total_bytes_str)s|%(progress._total_bytes_estimate_str)s'

export interface DownloadResult {
  code: number
  filePath?: string
  error?: string
}

export interface DownloadHandle {
  child: ChildProcess
  done: Promise<DownloadResult>
}

/**
 * Start a download. Emits progress via onProgress; resolves when the process exits.
 * Returns a handle so the caller can kill it (pause/cancel).
 */
export function startDownload(opts: {
  id: string
  url: string
  format: FormatKind
  outputDir: string
  outputBase: string
  referer?: string
  onProgress: (p: ProgressUpdate) => void
}): DownloadHandle {
  const { id, url, format, outputDir, outputBase, referer, onProgress } = opts
  const args = [
    '--newline',
    // --print (below) implies --quiet, which suppresses progress; --progress
    // forces the progress lines to be emitted anyway.
    '--progress',
    '--no-warnings',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--continue',
    '--no-mtime',
    '-P',
    outputDir,
    '-o',
    // outputBase is pre-sanitized (no % etc.), so it's a safe literal stem.
    `${outputBase}.%(ext)s`,
    '--print',
    'after_move:GBYFILE|%(filepath)s',
    ...formatArgs(format),
    ...ffmpegArgs(),
    ...cookieArgs(),
    ...refererArgs(referer),
    ...IMPERSONATE_ARGS,
    url
  ]

  const child = spawn(ytdlpPath(), args, { windowsHide: true, env: spawnEnv() })
  let filePath: string | undefined
  let buf = ''

  const handleLine = (line: string): void => {
    const t = line.trim()
    if (t.startsWith('GBY|')) {
      const [, percentStr, speed, eta, dl, total, totalEst] = t.split('|')
      const percent = parseFloat((percentStr || '').replace('%', '')) || 0
      const clean = (s?: string): string => {
        const v = (s || '').trim()
        return v && v !== 'NA' ? v : ''
      }
      onProgress({
        id,
        percent,
        speed: clean(speed),
        eta: clean(eta),
        downloaded: clean(dl),
        total: clean(total) || clean(totalEst)
      })
    } else if (t.startsWith('GBYFILE|')) {
      filePath = t.slice('GBYFILE|'.length)
    }
  }

  const onData = (chunk: Buffer): void => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
    }
  }
  child.stdout?.on('data', onData)

  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString()
  })

  const done = new Promise<DownloadResult>((resolve) => {
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf)
      if (code !== 0 && code !== null) {
        // Surface the last meaningful stderr line as the error.
        const lines = stderr.split('\n').filter(Boolean)
        const last = lines[lines.length - 1] || `yt-dlp exited with code ${code}`
        resolve({ code, error: last })
      } else {
        resolve({ code: code ?? 0, filePath })
      }
    })
    child.on('error', (err) => resolve({ code: 1, error: err.message }))
  })

  return { child, done }
}

/** Run `yt-dlp -U` to self-update the bundled binary. */
export async function updateYtdlp(): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout, stderr } = await run(['-U'], 120_000)
    return { ok: true, message: (stdout + stderr).trim() || 'yt-dlp is up to date.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}
