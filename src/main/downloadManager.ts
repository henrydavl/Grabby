import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { join } from 'path'
import { net } from 'electron'
import {
  MAX_AUTO_RETRIES,
  type AppSettings,
  type DownloadItem,
  type DownloadSpec,
  type DownloadStatus,
  type ExternalRequest,
  type ProgressUpdate
} from '../shared/types'
import {
  startDownload,
  resolveOutputBase,
  resolveFormats,
  ffmpegBinary,
  type DownloadResult
} from './ytdlp'
import { startSubtitleDownload, resolveSubtitlePath, subtitleExtFromUrl } from './subs'
import { isRetryable, retryDelayMs } from './retryPolicy'
import { saveQueue } from './queueStore'
import type { EngineProgress } from './engine/segmented'
import { HlsDownload } from './engine/hls'
import { ProgressiveDownload } from './engine/progressive'
import { formatBytes, formatEta } from './engine/format'
import { hostOf, parseYtdlpCookies } from './engine/http'
import { isYouTubeUrl, routeFor, type ResolvedFormat } from './engine/route'

interface Runtime {
  child?: ChildProcess
  /** Abort fn for an in-process download (subtitle file or Grabby's engine). */
  abort?: () => void
  /** True when a non-zero exit was caused by an intentional pause/cancel kill. */
  intentionalStop?: 'paused' | 'canceled'
  /** Highest percent seen this run, so the bar never jumps backward (YouTube
   * downloads video then audio as separate 0→100 passes). */
  maxPercent?: number
  /** Pending automatic retry while status === 'retrying'. */
  retryTimer?: NodeJS.Timeout
  /** Percent when the last run failed; progress past it resets the retry budget. */
  percentAtFailure?: number
}

// Statuses that occupy a concurrency slot (a process/request is running).
const RUNNING: DownloadStatus[] = ['preparing', 'downloading']

/** 401/403/410 or an explicit expiry: the link (token, cookies) is no longer valid. */
function looksExpired(error: string | undefined): boolean {
  return !!error && /HTTP Error (401|403|410)|expired|Forbidden/i.test(error)
}

function withoutHash(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href.replace(/\/$/, '')
  } catch {
    return url
  }
}

function samePage(a: string, b: string): boolean {
  return withoutHash(a) === withoutHash(b)
}

/** Same file even if its token/query changed. */
function sameResource(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname === y.pathname
  } catch {
    return false
  }
}

// How often to re-check connectivity while a retry waits for the network.
const OFFLINE_POLL_MS = 5_000
// Throttle for writing queue.json (progress patches arrive several times a second).
const PERSIST_DELAY_MS = 1_500

/**
 * Owns the download queue: enforces a concurrency limit and drives each item's
 * lifecycle, including automatic retries after transient failures. Emits
 * 'progress' (ProgressUpdate) and 'item' (DownloadItem) events which the IPC
 * layer forwards to the renderer, and persists the list to disk.
 */
export class DownloadManager extends EventEmitter {
  private items = new Map<string, DownloadItem>()
  private runtime = new Map<string, Runtime>()
  private order: string[] = []
  private persistTimer?: NodeJS.Timeout

  constructor(
    private settings: AppSettings,
    saved: DownloadItem[] = []
  ) {
    super()
    for (const item of saved) {
      // Anything that was mid-flight when the app quit comes back paused; its
      // .part file lets yt-dlp --continue pick up where it stopped.
      const interrupted = !['queued', 'paused', 'completed', 'error', 'canceled'].includes(item.status)
      const restored: DownloadItem = {
        ...item,
        status: interrupted ? 'paused' : item.status,
        speed: '',
        eta: '',
        notice: undefined,
        retryAt: undefined
      }
      this.items.set(item.id, restored)
      this.runtime.set(item.id, {})
      this.order.push(item.id)
    }
    this.pump()
  }

  updateSettings(s: AppSettings): void {
    this.settings = s
    this.pump()
  }

  list(): DownloadItem[] {
    return this.order.map((id) => this.items.get(id)!).filter(Boolean)
  }

  add(specs: DownloadSpec[]): DownloadItem[] {
    const created: DownloadItem[] = []
    for (const s of specs) {
      const item: DownloadItem = {
        id: randomUUID(),
        url: s.url,
        title: s.title || s.url,
        format: s.format,
        formatLabel: s.formatLabel,
        referer: s.referer,
        headers: s.headers,
        page: s.page,
        status: 'queued',
        percent: 0,
        speed: '',
        eta: '',
        outputDir: this.settings.outputDir,
        kind: s.kind,
        subExt: s.subExt
      }
      this.items.set(item.id, item)
      this.runtime.set(item.id, {})
      this.order.push(item.id)
      created.push(item)
    }
    this.pump()
    this.schedulePersist()
    return created
  }

  pause(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    if (rt.child || rt.abort) {
      rt.intentionalStop = 'paused'
      rt.child?.kill('SIGTERM')
      rt.abort?.()
    } else if (item.status === 'queued' || item.status === 'retrying') {
      this.clearRetry(rt)
      this.patch(id, { status: 'paused', retryAt: undefined })
    }
  }

  /** Resume a paused item, or retry a failed / waiting one right away. */
  resume(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    if (item.status !== 'paused' && item.status !== 'error' && item.status !== 'retrying') return
    this.clearRetry(rt)
    // A manual resume/retry is a fresh start: give it the full retry budget again.
    this.patch(id, { status: 'queued', attempt: 0, retryAt: undefined, error: undefined })
    this.pump()
  }

  cancel(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    if (rt.child || rt.abort) {
      rt.intentionalStop = 'canceled'
      rt.child?.kill('SIGTERM')
      rt.abort?.()
    } else {
      this.clearRetry(rt)
      this.patch(id, { status: 'canceled', retryAt: undefined })
    }
  }

  remove(id: string): void {
    // Stop it if running (leaves any .part on disk — we never delete files), then
    // drop it from the list and tell the renderer so the row disappears.
    this.cancel(id)
    this.items.delete(id)
    this.runtime.delete(id)
    this.order = this.order.filter((x) => x !== id)
    this.emit('removed', id)
    this.schedulePersist()
  }

  getFilePath(id: string): string | undefined {
    return this.items.get(id)?.filePath
  }

  /**
   * IDM's "refresh download address": when the extension sends a request from
   * the page of a download whose sniffed link expired, give that download the
   * fresh link (and cookies) instead of starting a new one — it resumes from
   * the bytes it already has. Returns the refreshed item, or null if none matched.
   */
  refreshFrom(req: ExternalRequest): DownloadItem | null {
    if (req.kind === 'subtitle') return null
    const page = req.candidates[0]?.url
    if (!page) return null
    const streams = req.candidates.slice(1)
    for (const item of this.list()) {
      const waiting = item.status === 'error' || item.status === 'retrying'
      if (!waiting || item.kind === 'subtitle' || !looksExpired(item.error)) continue
      if (!item.page || !samePage(item.page, page) || item.url === item.page) continue
      const fresh =
        streams.find((c) => sameResource(c.url, item.url)) ??
        streams.find((c) => hostOf(c.url) === hostOf(item.url))
      if (!fresh) continue
      const rt = this.runtime.get(item.id)
      if (rt) this.clearRetry(rt)
      this.patch(item.id, {
        url: fresh.url,
        headers: fresh.headers,
        referer: fresh.referer ?? item.referer,
        status: 'queued',
        attempt: 0,
        retryAt: undefined,
        error: undefined,
        notice: 'Link refreshed from the browser — resuming'
      })
      this.pump()
      return this.items.get(item.id) ?? null
    }
    return null
  }

  /**
   * App is quitting: stop every running process (they would otherwise keep
   * writing to the same .part files after a relaunch) and save the queue with
   * those items marked paused.
   */
  shutdown(): void {
    for (const [id, rt] of this.runtime) {
      this.clearRetry(rt)
      const item = this.items.get(id)
      if (!item) continue
      if (rt.child || rt.abort) {
        rt.intentionalStop = 'paused'
        rt.child?.kill('SIGTERM')
        rt.abort?.()
      }
      if (RUNNING.includes(item.status) || item.status === 'retrying') {
        Object.assign(item, { status: 'paused', speed: '', eta: '', retryAt: undefined })
      }
    }
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    saveQueue(this.list())
  }

  private runningCount(): number {
    return this.list().filter((i) => RUNNING.includes(i.status)).length
  }

  /** Start as many queued items as the concurrency limit allows. */
  private pump(): void {
    for (const id of this.order) {
      if (this.runningCount() >= this.settings.maxConcurrent) break
      const item = this.items.get(id)
      if (item && item.status === 'queued') this.startOne(id)
    }
  }

  private startOne(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return

    if (item.kind === 'subtitle') {
      this.startSubtitle(id)
      return
    }
    // Everything except YouTube (already at line speed via yt-dlp) and audio-only
    // (needs yt-dlp's mp3 conversion) is resolved first and, where the formats
    // allow, transferred by Grabby's own engines.
    if (item.format !== 'audio' && !item.useYtdlp && !isYouTubeUrl(item.url)) {
      this.startResolved(id)
      return
    }

    // "preparing" = process started but no progress yet (metadata extraction +
    // signature solving can take 10–20s before the first byte). The UI shows an
    // indeterminate bar so it doesn't look frozen at 0%.
    rt.maxPercent = 0
    // Resolve a non-clobbering filename once (IDM-style "(1)", "(2)" suffixes),
    // then reuse it across pause/resume so --continue finds its .part file.
    if (!item.outputBase) {
      item.outputBase = resolveOutputBase(item.outputDir, item.title, item.format)
    }
    this.patch(id, {
      status: 'preparing',
      percent: 0,
      speed: '',
      eta: '',
      notice: undefined,
      retryAt: undefined,
      error: undefined
    })

    const handle = startDownload({
      id,
      url: item.url,
      format: item.format,
      outputDir: item.outputDir,
      outputBase: item.outputBase,
      referer: item.referer,
      headers: item.headers,
      onProgress: (p: ProgressUpdate) => {
        // Keep the bar monotonic across the video→audio passes.
        const percent = Math.max(rt.maxPercent ?? 0, p.percent)
        rt.maxPercent = percent
        const update: ProgressUpdate = { ...p, percent }
        this.patch(id, {
          status: 'downloading',
          percent,
          speed: p.speed,
          eta: p.eta,
          downloaded: p.downloaded,
          total: p.total,
          notice: undefined,
          ...this.progressedPastFailure(rt, percent)
        })
        this.emit('progress', update)
      },
      onRetry: (count) => {
        this.patch(id, { speed: '', eta: '', notice: `Connection lost — retrying (${count})` })
      }
    })
    rt.child = handle.child

    handle.done.then((res) => {
      rt.child = undefined
      this.settle(id, res)
    })
  }

  /**
   * Resolve with yt-dlp (fresh URLs + cookies on every start, so expiring links
   * renew on each retry), then transfer with Grabby's engines: plain http(s)
   * formats with the multi-connection engine (separate video + audio merged),
   * HLS with the HLS engine. Anything else is handed to yt-dlp.
   */
  private startResolved(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return

    if (!item.outputBase) {
      item.outputBase = resolveOutputBase(item.outputDir, item.title, item.format)
    }
    this.patch(id, {
      status: 'preparing',
      percent: 0,
      speed: '',
      eta: '',
      notice: undefined,
      retryAt: undefined,
      error: undefined,
      connections: undefined
    })

    let stopped = false
    let job: { stop: () => void } | null = null
    rt.abort = () => {
      stopped = true
      job?.stop()
    }

    const stem = join(item.outputDir, item.outputBase)
    // yt-dlp's request headers, then the browser's own (cookies, exact Referer/UA) on top.
    const headersFor = (f: ResolvedFormat): Record<string, string> => ({
      ...(item.referer ? { Referer: item.referer } : {}),
      ...f.httpHeaders,
      ...item.headers
    })
    const common = {
      // The browser's cookies were captured for the sniffed URL's host only.
      credentialHost: hostOf(item.url),
      ffmpeg: ffmpegBinary(),
      connections: this.settings.connections,
      onProgress: (p: EngineProgress) => this.engineProgress(id, p)
    }

    const run = async (): Promise<DownloadResult> => {
      const { extractor, formats } = await resolveFormats(item.url, item.format, item.referer, item.headers)
      if (stopped) return { code: 1, error: 'stopped' }
      const route = routeFor(extractor, formats)
      if (route.kind === 'ytdlp') return { code: 1, error: route.reason, fallback: true, quiet: true }
      if (route.kind === 'hls') {
        const hls = new HlsDownload({
          ...common,
          tracks: route.formats.map((f) => f.url),
          headers: headersFor(route.formats[0]),
          cookies: parseYtdlpCookies(route.formats[0].cookies),
          destPath: `${stem}.mp4`
        })
        job = hls
        return hls.run()
      }
      const progressive = new ProgressiveDownload({
        ...common,
        tracks: route.formats.map((f) => ({
          url: f.url,
          ext: f.ext,
          headers: headersFor(f),
          cookies: parseYtdlpCookies(f.cookies)
        })),
        destStem: stem
      })
      job = progressive
      return progressive.run()
    }

    run()
      .catch((e): DownloadResult => ({ code: 1, error: e instanceof Error ? e.message : String(e) }))
      .then((res) => {
        rt.abort = undefined
        this.settle(id, res)
      })
  }

  /** Progress from one of Grabby's engines → item fields (yt-dlp-style strings). */
  private engineProgress(id: string, p: EngineProgress): void {
    const rt = this.runtime.get(id)
    if (!rt) return
    // Still connecting to a fresh download: stay in "preparing".
    if (p.downloaded === 0 && p.connections === 0 && !p.reconnecting) return
    const percent = p.total ? (100 * p.downloaded) / p.total : 0
    const update: ProgressUpdate = {
      id,
      percent,
      speed: p.speed > 0 ? `${formatBytes(p.speed)}/s` : '',
      eta: p.total && p.speed > 0 ? formatEta((p.total - p.downloaded) / p.speed) : '',
      downloaded: formatBytes(p.downloaded),
      total: p.total ? formatBytes(p.total) : '',
      connections: p.connections
    }
    this.patch(id, {
      status: 'downloading',
      percent,
      speed: update.speed,
      eta: update.eta,
      downloaded: update.downloaded,
      total: update.total,
      connections: p.connections,
      notice: p.reconnecting ? 'Connection lost — reconnecting…' : undefined,
      ...this.progressedPastFailure(rt, percent)
    })
    this.emit('progress', update)
  }

  /** Download a sniffed subtitle file directly (no yt-dlp). */
  private startSubtitle(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return

    const ext = item.subExt || subtitleExtFromUrl(item.url)
    const destPath = item.filePath || resolveSubtitlePath(item.outputDir, item.title, ext)
    item.filePath = destPath // reuse the same name across a resume
    this.patch(id, { status: 'downloading', percent: 0, error: undefined, filePath: destPath })

    const handle = startSubtitleDownload({
      id,
      url: item.url,
      destPath,
      referer: item.referer,
      headers: item.headers,
      onProgress: (p) => {
        this.patch(id, {
          status: 'downloading',
          percent: p.percent,
          downloaded: p.downloaded,
          total: p.total
        })
        this.emit('progress', p)
      }
    })
    rt.abort = handle.abort

    handle.done.then((res) => {
      rt.abort = undefined
      this.settle(id, res)
    })
  }

  /** Route a finished run to its next state: paused/canceled/done, an automatic retry, or failed. */
  private settle(id: string, res: DownloadResult): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    const stop = rt.intentionalStop
    rt.intentionalStop = undefined
    const idle = { speed: '', eta: '', notice: undefined, connections: undefined }

    if (stop === 'paused') {
      this.patch(id, { status: 'paused', ...idle })
    } else if (stop === 'canceled') {
      this.patch(id, { status: 'canceled', ...idle })
    } else if (res.code === 0) {
      this.patch(id, { status: 'completed', percent: 100, ...idle, filePath: res.filePath })
    } else if (res.fallback) {
      // Our engines can't (or shouldn't) fetch this one: hand it to yt-dlp right
      // away, without spending a retry attempt.
      this.patch(id, {
        status: 'queued',
        useYtdlp: true,
        ...idle,
        notice: res.quiet ? undefined : 'Switching to yt-dlp…'
      })
    } else if (isRetryable(res.error) && (item.attempt ?? 0) < MAX_AUTO_RETRIES) {
      this.scheduleRetry(id, res.error)
    } else {
      // A sniffed link that expired can only be renewed from the browser.
      const hint =
        looksExpired(res.error) && item.page && item.url !== item.page
          ? ' — the link expired: play the video on its page and click Grabby’s ⬇ again to resume'
          : ''
      this.patch(id, { status: 'error', ...idle, retryAt: undefined, error: `${res.error ?? 'failed'}${hint}` })
    }
    this.pump()
  }

  private scheduleRetry(id: string, error: string | undefined): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    const attempt = (item.attempt ?? 0) + 1
    const delay = retryDelayMs(attempt)
    rt.percentAtFailure = item.percent
    this.patch(id, {
      status: 'retrying',
      attempt,
      retryAt: Date.now() + delay,
      speed: '',
      eta: '',
      notice: undefined,
      error
    })
    rt.retryTimer = setTimeout(() => this.fireRetry(id), delay)
  }

  /** Retry timer fired: re-queue the item, or keep waiting while offline (doesn't use up attempts). */
  private fireRetry(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    rt.retryTimer = undefined
    if (item.status !== 'retrying') return
    if (!net.isOnline()) {
      this.patch(id, { retryAt: Date.now() + OFFLINE_POLL_MS, notice: 'Waiting for network…' })
      rt.retryTimer = setTimeout(() => this.fireRetry(id), OFFLINE_POLL_MS)
      return
    }
    // Back into the queue (not started directly) so the concurrency limit holds.
    this.patch(id, { status: 'queued', retryAt: undefined, notice: undefined })
    this.pump()
  }

  /** Once a retried download gets further than where it failed, restore its retry budget. */
  private progressedPastFailure(rt: Runtime, percent: number): Partial<DownloadItem> {
    if (rt.percentAtFailure === undefined || percent <= rt.percentAtFailure + 1) return {}
    rt.percentAtFailure = undefined
    return { attempt: 0 }
  }

  private clearRetry(rt: Runtime): void {
    if (rt.retryTimer) clearTimeout(rt.retryTimer)
    rt.retryTimer = undefined
  }

  /** Apply a partial update and emit it. */
  private patch(id: string, partial: Partial<DownloadItem>): void {
    const item = this.items.get(id)
    if (!item) return
    Object.assign(item, partial)
    this.emit('item', { ...item })
    this.schedulePersist()
  }

  /** Save queue.json at most once per PERSIST_DELAY_MS, with the latest state. */
  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      saveQueue(this.list())
    }, PERSIST_DELAY_MS)
  }
}
