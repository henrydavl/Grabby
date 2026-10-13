import type { ClientRequest, IncomingMessage } from 'http'
import { existsSync, promises as fsp } from 'fs'
import { dirname } from 'path'
import type { HttpHeaders } from '../../shared/types'
import { EngineError, httpError, isAuthError, retryDelay, toEngineError } from './errors'
import { HttpClient, type CookieEntry } from './http'

/**
 * Grabby's own multi-connection HTTP downloader, modelled on IDM's "dynamic
 * segmentation": the first connection starts at byte 0 and learns the file size;
 * every connection that becomes free takes over the second half of the largest
 * unfinished segment, so all connections stay busy until the very end and a
 * slow one never holds up the tail. Hosts that throttle per connection (most
 * video embed hosts) get N× the speed of a single-connection download.
 *
 * Progress is written to a state file every couple of seconds, so a paused,
 * crashed, or failed download resumes byte-exactly from the .grabby-part file.
 */

export interface EngineProgress {
  downloaded: number
  total: number | null
  /** Bytes per second, smoothed. */
  speed: number
  /** Connections currently transferring. */
  connections: number
  /** True while every connection is waiting to retry after an error. */
  reconnecting: boolean
}

export interface EngineResult {
  code: number
  filePath?: string
  error?: string
  /** This engine can't fetch the file (blocked, not a media file, no ranges
   * mid-download…); the caller should hand it to yt-dlp instead. */
  fallback?: boolean
}

export interface SegmentedOptions {
  url: string
  headers: HttpHeaders
  /** Host the captured Cookie/Authorization belong to (never sent elsewhere). */
  credentialHost: string | null
  /** Scoped cookies from yt-dlp for this format. */
  cookies?: CookieEntry[]
  /** Final path; work happens in `${destPath}.grabby-part` + `.grabby-state.json`. */
  destPath: string
  /** Max parallel connections (1 disables splitting). */
  connections: number
  onProgress: (p: EngineProgress) => void
}

interface Segment {
  start: number
  /** Inclusive; Infinity until the size is known. Shrinks when the segment is split. */
  end: number
  /** Next byte to write. Done when pos > end. */
  pos: number
  owner: ClientRequest | 'pending' | null
  attempts: number
  retryAt: number
}

interface SavedState {
  version: 1
  url: string
  size: number
  etag?: string
  lastModified?: string
  segments: { start: number; end: number; pos: number }[]
}

const MIN_SPLIT = 1024 * 1024 // never create a segment smaller than this
const NO_PROGRESS_LIMIT_MS = 120_000 // give up (and let the queue's retry/backoff take over)
const STATE_INTERVAL_MS = 2_000
const PROGRESS_INTERVAL_MS = 500
const AUTH_RETRIES = 3 // 403s after data flowed, before calling the link expired

function resourceKey(url: string): string {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch {
    return url
  }
}

export class SegmentedDownload {
  private readonly partPath: string
  private readonly statePath: string
  private readonly http: HttpClient
  private fd: fsp.FileHandle | null = null

  private segments: Segment[] = []
  private size: number | null = null
  /** undefined until the first response tells us. */
  private rangeOk: boolean | undefined
  private etag?: string
  private lastModified?: string
  private maxConns: number

  private stopped = false
  /** Some bytes arrived during this run (an auth error after that = expired link, not a block). */
  private receivedAny = false
  private failure: EngineError | null = null
  private wake: (() => void) | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private lastProgressAt = Date.now()
  private bytesSinceTick = 0
  private speed = 0

  constructor(private opts: SegmentedOptions) {
    this.partPath = `${opts.destPath}.grabby-part`
    this.statePath = `${opts.destPath}.grabby-state.json`
    this.maxConns = Math.max(1, Math.floor(opts.connections))
    this.http = new HttpClient(opts.headers, opts.credentialHost, opts.cookies)
  }

  /** Abort all connections; run() resolves with the state saved for a later resume. */
  stop(): void {
    this.stopped = true
    for (const s of this.segments) if (s.owner && s.owner !== 'pending') s.owner.destroy()
    this.notify()
  }

  async run(): Promise<EngineResult> {
    const progressTimer = setInterval(() => this.reportProgress(), PROGRESS_INTERVAL_MS)
    const stateTimer = setInterval(() => void this.saveState(), STATE_INTERVAL_MS)
    try {
      await this.prepare()
      while (!this.stopped && !this.failure && !this.isComplete()) {
        this.fillConnections()
        if (this.activeCount() === 0 && !this.retryTimer && !this.hasRunnableWork()) break
        if (Date.now() - this.lastProgressAt > NO_PROGRESS_LIMIT_MS) {
          throw new EngineError('no data received for 2 minutes', 'transient')
        }
        let tick: NodeJS.Timeout | undefined
        await new Promise<void>((resolve) => {
          this.wake = resolve
          // Re-check periodically even without events (no-progress limit).
          tick = setTimeout(resolve, 5_000)
        })
        clearTimeout(tick)
        this.wake = null
      }
      if (this.failure) throw this.failure
      if (this.stopped) {
        await this.waitForIdle()
        await this.saveState()
        return { code: 1, error: 'stopped' }
      }
      if (!this.isComplete()) throw new EngineError('download ended incomplete', 'transient')
      await this.finish()
      this.reportProgress()
      return { code: 0, filePath: this.opts.destPath }
    } catch (e) {
      const err = toEngineError(e)
      this.stop()
      await this.waitForIdle()
      if (err.kind === 'fallback') {
        await this.discard()
        return { code: 1, error: err.message, fallback: true }
      }
      await this.saveState()
      return { code: 1, error: err.message }
    } finally {
      clearInterval(progressTimer)
      clearInterval(stateTimer)
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.http.destroy()
      await this.fd?.close().catch(() => {})
      this.fd = null
    }
  }

  // --- setup / teardown --------------------------------------------------------

  private async prepare(): Promise<void> {
    await fsp.mkdir(dirname(this.opts.destPath), { recursive: true })
    const saved = await this.loadState()
    if (saved && existsSync(this.partPath)) {
      this.size = saved.size
      this.etag = saved.etag
      this.lastModified = saved.lastModified
      this.rangeOk = true
      this.segments = saved.segments
        .filter((s) => s.pos <= s.end)
        .map((s) => ({ ...s, owner: null, attempts: 0, retryAt: 0 }))
      this.fd = await fsp.open(this.partPath, 'r+')
      return
    }
    await fsp.rm(this.statePath, { force: true })
    this.fd = await fsp.open(this.partPath, 'w+')
    this.segments = [{ start: 0, end: Infinity, pos: 0, owner: null, attempts: 0, retryAt: 0 }]
  }

  private async finish(): Promise<void> {
    await this.fd?.close()
    this.fd = null
    if (this.size !== null) {
      const { size } = await fsp.stat(this.partPath)
      if (size !== this.size) throw new EngineError(`size mismatch (${size} ≠ ${this.size})`, 'transient')
    }
    await fsp.rename(this.partPath, this.opts.destPath)
    await fsp.rm(this.statePath, { force: true })
  }

  /** Remove our own temp files (the caller is switching to yt-dlp). */
  private async discard(): Promise<void> {
    await this.fd?.close().catch(() => {})
    this.fd = null
    await fsp.rm(this.partPath, { force: true })
    await fsp.rm(this.statePath, { force: true })
  }

  private async loadState(): Promise<SavedState | null> {
    try {
      const s = JSON.parse(await fsp.readFile(this.statePath, 'utf-8')) as SavedState
      // Same resource even if its token/query changed (a refreshed link); the
      // first response re-checks size + ETag before any byte is reused.
      return s.version === 1 && resourceKey(s.url) === resourceKey(this.opts.url) && s.size > 0 ? s : null
    } catch {
      return null
    }
  }

  /** Only resumable downloads (known size + range support) are worth saving. */
  private async saveState(): Promise<void> {
    if (this.size === null || !this.rangeOk || this.isComplete()) return
    const state: SavedState = {
      version: 1,
      url: this.opts.url,
      size: this.size,
      etag: this.etag,
      lastModified: this.lastModified,
      segments: this.segments.map(({ start, end, pos }) => ({ start, end, pos }))
    }
    try {
      const tmp = `${this.statePath}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(state))
      await fsp.rename(tmp, this.statePath)
    } catch {
      /* next tick retries */
    }
  }

  // --- scheduling --------------------------------------------------------------

  private notify(): void {
    this.wake?.()
  }

  private activeCount(): number {
    return this.segments.filter((s) => s.owner !== null).length
  }

  private isComplete(): boolean {
    return this.size !== null && this.segments.every((s) => s.pos > s.end && s.owner === null)
  }

  private hasRunnableWork(): boolean {
    return this.segments.some((s) => s.owner === null && s.pos <= s.end)
  }

  private async waitForIdle(): Promise<void> {
    for (let i = 0; i < 100 && this.activeCount() > 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** Start connections until we hit the limit or run out of work. */
  private fillConnections(): void {
    while (!this.stopped && this.activeCount() < this.maxConns) {
      const seg = this.nextWork()
      if (!seg) break
      seg.owner = 'pending'
      void this.runSegment(seg)
    }
  }

  private nextWork(): Segment | null {
    const now = Date.now()
    // 1. Unowned unfinished work that's due (resumed segments, failed connections).
    const waiting = this.segments.filter((s) => s.owner === null && s.pos <= s.end)
    const due = waiting.find((s) => s.retryAt <= now)
    if (due) return due
    if (waiting.length) this.scheduleRetryWake(Math.min(...waiting.map((s) => s.retryAt)) - now)

    // 2. Split the largest in-flight segment (only once ranges are known to work).
    if (!this.rangeOk || this.size === null) return null
    let largest: Segment | null = null
    for (const s of this.segments) {
      if (s.owner === null) continue
      if (!largest || s.end - s.pos > largest.end - largest.pos) largest = s
    }
    if (!largest) return null
    const remaining = largest.end - largest.pos + 1
    if (remaining < 2 * MIN_SPLIT) return null
    const mid = largest.pos + Math.ceil(remaining / 2)
    const fresh: Segment = { start: mid, end: largest.end, pos: mid, owner: null, attempts: 0, retryAt: 0 }
    largest.end = mid - 1
    this.segments.push(fresh)
    return fresh
  }

  private scheduleRetryWake(delayMs: number): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.notify()
    }, Math.max(0, delayMs))
  }

  // --- one connection ------------------------------------------------------------

  private async runSegment(seg: Segment): Promise<void> {
    try {
      await this.fetchSegment(seg)
      seg.attempts = 0
    } catch (e) {
      if (!this.stopped) this.onSegmentError(seg, toEngineError(e))
    } finally {
      seg.owner = null
      this.notify()
    }
  }

  private onSegmentError(seg: Segment, err: EngineError): void {
    const othersWorking = this.segments.some((s) => s !== seg && s.owner !== null)
    // A 403/429/503 while sibling connections are fine means the host limits
    // connections: back off with one fewer instead of failing the download.
    if ((err.kind === 'throttled' || err.kind === 'fallback') && othersWorking && this.rangeOk) {
      this.maxConns = Math.max(1, this.activeCount() - 1)
      seg.attempts++
      seg.retryAt = Date.now() + (err.retryAfterMs ?? retryDelay(seg.attempts))
      return
    }
    if (err.kind === 'fallback' && this.receivedAny && isAuthError(err)) {
      // It worked until now, so this is a lagging connection limit or an
      // expired link, not a block. Retry a few times; if it persists, keep the
      // bytes and let the queue retry (and resume) later.
      if (seg.attempts < AUTH_RETRIES) {
        seg.attempts++
        seg.retryAt = Date.now() + retryDelay(seg.attempts)
        return
      }
      this.failure = new EngineError(err.message, 'transient')
      this.stop()
      return
    }
    if (err.kind === 'fatal' || err.kind === 'fallback') {
      this.failure = err
      this.stop()
      return
    }
    if (err.kind === 'throttled') this.maxConns = Math.max(1, this.maxConns - 1)
    if (!this.rangeOk) {
      // No range support: the only way to retry is from the beginning.
      seg.pos = seg.start = 0
      void this.fd?.truncate(0).catch(() => {})
    }
    seg.attempts++
    seg.retryAt = Date.now() + (err.retryAfterMs ?? retryDelay(seg.attempts))
  }

  private async fetchSegment(seg: Segment): Promise<void> {
    const range =
      this.rangeOk === false ? null : `bytes=${seg.pos}-${Number.isFinite(seg.end) ? seg.end : ''}`
    const { res, req } = await this.http.open(this.opts.url, range)
    if (this.stopped) {
      req.destroy()
      return
    }
    seg.owner = req
    try {
      this.acceptResponse(seg, res)
      for await (const chunk of res as AsyncIterable<Buffer>) {
        if (this.stopped || !this.fd) break
        const room = seg.end - seg.pos + 1 // the segment may have been split meanwhile
        const piece = chunk.length > room ? chunk.subarray(0, room) : chunk
        await this.fd.write(piece, 0, piece.length, seg.pos)
        seg.pos += piece.length
        this.receivedAny = true
        this.bytesSinceTick += piece.length
        this.lastProgressAt = Date.now()
        if (seg.pos > seg.end) break
      }
    } finally {
      // Stop the transfer if we broke out early (split, done, or stopped).
      if (!res.complete) req.destroy()
    }
    if (this.stopped) return
    if (!Number.isFinite(seg.end)) {
      // Unknown length: the stream ending is the end of the file.
      seg.end = seg.pos - 1
      this.size = seg.pos
      return
    }
    if (seg.pos <= seg.end) throw new EngineError('connection closed early', 'transient')
  }

  /** Validate a response and learn size / range support from the first one. */
  private acceptResponse(seg: Segment, res: IncomingMessage): void {
    const status = res.statusCode ?? 0
    const firstResponse = this.rangeOk === undefined
    if (status !== 200 && status !== 206) {
      res.resume()
      throw httpError(status, res.headers['retry-after'] as string | undefined)
    }
    const type = String(res.headers['content-type'] || '').toLowerCase()
    if (type.startsWith('text/html')) {
      res.resume()
      throw new EngineError('server returned a web page instead of the file', 'fallback')
    }

    if (status === 206) {
      const m = String(res.headers['content-range'] || '').match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/)
      const total = m && m[3] !== '*' ? Number(m[3]) : null
      if (!m || Number(m[1]) !== seg.pos) {
        res.resume()
        throw new EngineError('server sent the wrong byte range', 'fallback')
      }
      const etag = res.headers.etag
      if (this.size !== null && ((total !== null && total !== this.size) || (this.etag && etag && etag !== this.etag))) {
        // The file changed on the server: our partial data is useless.
        res.resume()
        void fsp.rm(this.statePath, { force: true })
        throw new EngineError('file changed on the server', 'fallback')
      }
      if (firstResponse) {
        this.rangeOk = total !== null
        this.etag = etag
        this.lastModified = res.headers['last-modified']
        if (total !== null) this.setSize(seg, total)
      }
      return
    }

    // 200: the server ignored our Range header.
    if (seg.pos > 0) {
      res.resume()
      throw new EngineError('server stopped honoring byte ranges', 'fallback')
    }
    this.rangeOk = false
    this.maxConns = 1
    const length = Number(res.headers['content-length'])
    if (length > 0) this.setSize(seg, length)
  }

  private setSize(seg: Segment, total: number): void {
    this.size = total
    if (!Number.isFinite(seg.end)) seg.end = total - 1
    // Preallocate (sparse) so every connection can write at its own offset.
    void this.fd?.truncate(total).catch(() => {})
    // Size known: the scheduler can open the other connections right away.
    this.notify()
  }

  // --- reporting -----------------------------------------------------------------

  private downloaded(): number {
    return this.segments.reduce((sum, s) => sum + (s.pos - s.start), 0)
  }

  private reportProgress(): void {
    const instant = this.bytesSinceTick / (PROGRESS_INTERVAL_MS / 1000)
    this.bytesSinceTick = 0
    this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3
    const transferring = this.segments.filter((s) => s.owner !== null && s.owner !== 'pending').length
    const waiting = this.segments.some((s) => s.owner === null && s.pos <= s.end && s.retryAt > Date.now())
    this.opts.onProgress({
      downloaded: this.downloaded(),
      total: this.size,
      speed: this.speed,
      connections: transferring,
      reconnecting: transferring === 0 && waiting
    })
  }
}
