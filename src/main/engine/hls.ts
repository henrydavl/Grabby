import { createDecipheriv, createHash } from 'crypto'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, promises as fsp } from 'fs'
import { dirname } from 'path'
import type { ClientRequest } from 'http'
import type { HttpHeaders } from '../../shared/types'
import { EngineError, isAuthError, retryDelay, toEngineError } from './errors'
import { HttpClient } from './http'
import { parseMediaPlaylist, segmentIv, type ByteRange, type MediaPlaylist } from './m3u8'
import type { EngineProgress, EngineResult } from './segmented'

/**
 * Grabby's HLS (VOD) downloader. yt-dlp picks the variant(s); this fetches each
 * media playlist's segments over several connections, decrypts AES-128, strips
 * image headers that some embed hosts wrap around TS segments, appends them in
 * order to one file per track, and finally remuxes the track(s) with ffmpeg.
 *
 * Unlike yt-dlp's default it never silently skips a segment: a segment either
 * downloads or the whole job fails (and is retried/resumed later). Resume is
 * byte-exact: per track we only need "next segment index + bytes written".
 */

export interface HlsOptions {
  /** One media-playlist URL per track — video first, then a separate audio track if any. */
  tracks: string[]
  headers: HttpHeaders
  /** Host the captured Cookie/Authorization belong to (never sent elsewhere). */
  credentialHost: string | null
  /** Final output path (.mp4); falls back to .mkv if the codecs don't fit MP4. */
  destPath: string
  ffmpeg: string
  connections: number
  onProgress: (p: EngineProgress) => void
}

interface TrackState {
  fingerprint: string
  nextIndex: number
  bytes: number
  initDone: boolean
}

interface SavedState {
  version: 1
  tracks: TrackState[]
}

interface Track {
  url: string
  path: string
  connections: number
  playlist: MediaPlaylist
  state: TrackState
  fd: fsp.FileHandle | null
  totalDuration: number
  doneDuration: number
}

const NO_PROGRESS_LIMIT_MS = 120_000
const AUTH_RETRIES = 3 // 403s after data flowed, before calling the link expired
const PROGRESS_INTERVAL_MS = 500
const STATE_INTERVAL_MS = 2_000
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024
const READ_AHEAD = 4 // segments buffered per connection ahead of the writer

/**
 * Some hosts disguise TS segments as images (a PNG/JPEG header in front of the
 * real data). MPEG-TS packets are 188 bytes starting with 0x47: find the first
 * offset where three consecutive packets line up and drop what's before it.
 */
export function stripDisguise(buf: Buffer): Buffer {
  if (buf.length < 377 || buf[0] === 0x47) return buf
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return buf // raw AAC/MP3 audio segment
  const limit = Math.min(buf.length - 377, 64 * 1024)
  for (let k = 1; k <= limit; k++) {
    if (buf[k] === 0x47 && buf[k + 188] === 0x47 && buf[k + 376] === 0x47) return buf.subarray(k)
  }
  return buf
}

function fingerprint(pl: MediaPlaylist): string {
  const h = createHash('sha1')
  h.update(`${pl.segments.length}|${pl.map ? 'map' : ''}|`)
  for (const s of pl.segments) h.update(`${s.duration.toFixed(3)},`)
  return h.digest('hex')
}

export class HlsDownload {
  private readonly http: HttpClient
  private readonly statePath: string
  private tracks: Track[] = []
  private keys = new Map<string, Promise<Buffer>>()
  private inflight = new Set<ClientRequest>()
  private sleepers = new Set<() => void>()
  /** Requests currently waiting out a retry backoff. */
  private backingOff = 0
  private muxChild: ChildProcess | null = null

  private userStopped = false
  private failure: EngineError | null = null
  private receivedAny = false
  private lastProgressAt = Date.now()
  private bytesSinceTick = 0
  private speed = 0

  constructor(private opts: HlsOptions) {
    this.http = new HttpClient(opts.headers, opts.credentialHost)
    this.statePath = `${opts.destPath}.grabby-hls.json`
  }

  /** Pause/cancel: abort everything; run() resolves with progress saved for a resume. */
  stop(): void {
    this.userStopped = true
    this.abortAll()
  }

  async run(): Promise<EngineResult> {
    const progressTimer = setInterval(() => this.reportProgress(), PROGRESS_INTERVAL_MS)
    const stateTimer = setInterval(() => void this.saveState(), STATE_INTERVAL_MS)
    try {
      await fsp.mkdir(dirname(this.opts.destPath), { recursive: true })
      const saved = await this.loadState()
      const budget = this.connectionBudget()
      this.tracks = await Promise.all(
        this.opts.tracks.map((url, i) => this.prepareTrack(url, i, budget[i], saved?.tracks[i]))
      )
      await Promise.all(this.tracks.map((t) => this.downloadTrack(t)))
      if (this.failure) throw this.failure
      if (this.userStopped) throw new EngineError('stopped', 'transient')
      await this.closeFiles()
      this.reportProgress()
      const filePath = await this.mux()
      await this.removeTemp()
      return { code: 0, filePath }
    } catch (e) {
      const err = this.failure ?? toEngineError(e)
      this.abortAll()
      await this.closeFiles()
      if (this.userStopped) {
        await this.saveState()
        return { code: 1, error: 'stopped' }
      }
      if (err.kind === 'fallback') {
        await this.removeTemp()
        return { code: 1, error: err.message, fallback: true }
      }
      await this.saveState()
      return { code: 1, error: err.message }
    } finally {
      clearInterval(progressTimer)
      clearInterval(stateTimer)
      this.http.destroy()
    }
  }

  // --- control ---------------------------------------------------------------------

  private halted(): boolean {
    return this.userStopped || this.failure !== null
  }

  private abortAll(): void {
    for (const req of this.inflight) req.destroy()
    for (const wake of this.sleepers) wake()
    this.muxChild?.kill('SIGTERM')
  }

  /** Record the first unrecoverable error and stop every other worker. */
  private fail(err: EngineError): EngineError {
    if (!this.failure) this.failure = err
    this.abortAll()
    return err
  }

  private sleep(ms: number, backoff = false): Promise<void> {
    return new Promise((resolve) => {
      if (backoff) this.backingOff++
      const done = (): void => {
        clearTimeout(timer)
        this.sleepers.delete(done)
        if (backoff) this.backingOff--
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.sleepers.add(done)
    })
  }

  /** Video gets most connections; a separate audio track (much smaller) a quarter. */
  private connectionBudget(): number[] {
    const total = Math.max(1, Math.floor(this.opts.connections))
    if (this.opts.tracks.length === 1) return [total]
    const audio = Math.max(1, Math.round(total / 4))
    return [Math.max(1, total - audio), ...this.opts.tracks.slice(1).map(() => audio)]
  }

  // --- fetching with retries -----------------------------------------------------------

  /** Run one request with the engine's retry policy (shared by playlists, keys, segments). */
  private async retrying<T>(attemptFn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      if (this.halted()) throw this.failure ?? new EngineError('stopped', 'transient')
      try {
        return await attemptFn()
      } catch (e) {
        if (this.halted()) throw this.failure ?? e
        const err = toEngineError(e)
        if (err.kind === 'fatal') throw this.fail(err)
        if (err.kind === 'fallback') {
          // After data has flowed, a 401/403/410 is an expired token or a lagging
          // connection limit: retry a little, then fail *transiently* so the queue
          // re-resolves fresh URLs and resumes. Before that, it's a block.
          if (!(isAuthError(err) && this.receivedAny)) throw this.fail(err)
          if (attempt > AUTH_RETRIES) throw this.fail(new EngineError(err.message, 'transient'))
        }
        if (Date.now() - this.lastProgressAt > NO_PROGRESS_LIMIT_MS) {
          throw this.fail(new EngineError('no data received for 2 minutes', 'transient'))
        }
        await this.sleep(err.retryAfterMs ?? retryDelay(attempt), true)
      }
    }
  }

  private get(url: string, range?: ByteRange, maxBytes = MAX_SEGMENT_BYTES): Promise<{ body: Buffer; url: string }> {
    let current: ClientRequest | null = null
    return this.http.getBuffer(url, {
      range,
      maxBytes,
      track: (req) => {
        if (req) this.inflight.add((current = req))
        else if (current) this.inflight.delete(current)
      }
    })
  }

  private key(uri: string): Promise<Buffer> {
    let p = this.keys.get(uri)
    if (!p) {
      p = this.get(uri, undefined, 1024).then(({ body }) => {
        if (body.length !== 16) throw new EngineError('invalid AES-128 key', 'fallback')
        return body
      })
      p.catch(() => this.keys.delete(uri)) // let the next attempt refetch
      this.keys.set(uri, p)
    }
    return p
  }

  // --- tracks ----------------------------------------------------------------------------

  private async prepareTrack(url: string, i: number, connections: number, saved?: TrackState): Promise<Track> {
    const { body, url: finalUrl } = await this.retrying(() => this.get(url, undefined, 16 * 1024 * 1024))
    const playlist = parseMediaPlaylist(body.toString('utf8'), finalUrl)
    if (playlist.isMaster) throw this.fail(new EngineError('expected a media playlist', 'fallback'))
    if (!playlist.complete) throw this.fail(new EngineError('live stream', 'fallback'))
    if (playlist.segments.length === 0) throw this.fail(new EngineError('playlist has no segments', 'fatal'))
    if (playlist.multipleMaps) throw this.fail(new EngineError('multiple init segments', 'fallback'))
    const locked = playlist.segments.find(
      (s) => s.key && (s.key.method !== 'AES-128' || (s.key.keyFormat && s.key.keyFormat !== 'identity'))
    )
    if (locked) throw this.fail(new EngineError(`unsupported encryption (${locked.key!.method})`, 'fallback'))

    const fp = fingerprint(playlist)
    const path = `${this.opts.destPath}.t${i}.grabby-hls`
    const resume = saved && saved.fingerprint === fp && saved.bytes > 0 && existsSync(path)
    const state: TrackState = resume ? { ...saved } : { fingerprint: fp, nextIndex: 0, bytes: 0, initDone: false }
    const fd = await fsp.open(path, resume ? 'r+' : 'w+')
    // Drop anything written after the last saved point (partial segment).
    await fd.truncate(state.bytes)

    const track: Track = {
      url,
      path,
      connections,
      playlist,
      state,
      fd,
      totalDuration: playlist.segments.reduce((s, x) => s + x.duration, 0),
      doneDuration: playlist.segments.slice(0, state.nextIndex).reduce((s, x) => s + x.duration, 0)
    }
    if (playlist.map && !state.initDone) {
      const map = playlist.map
      const { body: init } = await this.retrying(() => this.get(map.uri, map.range))
      await fd.write(init, 0, init.length, 0)
      state.bytes = init.length
      state.initDone = true
    }
    return track
  }

  private async fetchSegment(t: Track, index: number): Promise<Buffer> {
    const seg = t.playlist.segments[index]
    return this.retrying(async () => {
      let { body } = await this.get(seg.uri, seg.range)
      if (seg.key) {
        const key = await this.key(seg.key.uri)
        try {
          const decipher = createDecipheriv('aes-128-cbc', key, segmentIv(seg))
          body = Buffer.concat([decipher.update(body), decipher.final()])
        } catch {
          throw new EngineError('could not decrypt segment', 'fallback')
        }
      }
      if (!t.playlist.map) body = stripDisguise(body)
      this.receivedAny = true
      this.lastProgressAt = Date.now()
      this.bytesSinceTick += body.length
      return body
    })
  }

  /** Parallel fetch, in-order append. */
  private async downloadTrack(t: Track): Promise<void> {
    const segments = t.playlist.segments
    let next = t.state.nextIndex
    const ready = new Map<number, Buffer>()
    let writing: Promise<void> = Promise.resolve()

    const flush = (): Promise<void> => {
      writing = writing.then(async () => {
        while (ready.has(t.state.nextIndex) && t.fd) {
          const index = t.state.nextIndex
          const buf = ready.get(index)!
          ready.delete(index)
          await t.fd.write(buf, 0, buf.length, t.state.bytes)
          t.state.bytes += buf.length
          t.doneDuration += segments[index].duration
          t.state.nextIndex++
        }
      })
      return writing
    }

    const worker = async (): Promise<void> => {
      while (!this.halted() && next < segments.length) {
        // Bounded memory: don't run too far ahead of the writer.
        if (next - t.state.nextIndex >= t.connections * READ_AHEAD) {
          await this.sleep(50)
          continue
        }
        const index = next++
        ready.set(index, await this.fetchSegment(t, index))
        await flush()
      }
    }

    const workers = Math.max(1, Math.min(t.connections, segments.length - next))
    const results = await Promise.allSettled(Array.from({ length: workers }, worker))
    await writing.catch(() => {})
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed && !this.userStopped) throw this.failure ?? failed.reason
  }

  // --- output ----------------------------------------------------------------------------

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        windowsHide: true
      })
      this.muxChild = child
      let stderr = ''
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
      child.on('error', (e) => reject(e))
      child.on('close', (code) => {
        this.muxChild = null
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
      })
    })
  }

  /** Remux the downloaded track(s) into one file without re-encoding. */
  private async mux(): Promise<string> {
    const inputs = this.tracks.flatMap((t) => ['-i', t.path])
    // Only audio/video: timed-ID3 data streams can't go into MP4.
    const maps = this.tracks.flatMap((_, i) => ['-map', `${i}:v?`, '-map', `${i}:a?`])
    const stem = this.opts.destPath.replace(/\.mp4$/i, '')
    const attempts: [string, string[]][] = [
      [`${stem}.mp4`, ['-movflags', '+faststart']],
      [`${stem}.mkv`, []] // codecs MP4 can't carry
    ]
    let lastError = ''
    for (const [out, extra] of attempts) {
      const tmp = `${stem}.grabby-mux${out.slice(stem.length)}`
      try {
        await this.runFfmpeg([...inputs, ...maps, '-c', 'copy', ...extra, tmp])
        await fsp.rename(tmp, out)
        return out
      } catch (e) {
        await fsp.rm(tmp, { force: true })
        if (this.userStopped) throw e
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    throw new EngineError(`remux failed: ${lastError}`, 'fallback')
  }

  private async closeFiles(): Promise<void> {
    for (const t of this.tracks) {
      await t.fd?.close().catch(() => {})
      t.fd = null
    }
  }

  private async removeTemp(): Promise<void> {
    await this.closeFiles()
    for (let i = 0; i < this.opts.tracks.length; i++) {
      await fsp.rm(`${this.opts.destPath}.t${i}.grabby-hls`, { force: true })
    }
    await fsp.rm(this.statePath, { force: true })
  }

  private async loadState(): Promise<SavedState | null> {
    try {
      const s = JSON.parse(await fsp.readFile(this.statePath, 'utf-8')) as SavedState
      return s.version === 1 && Array.isArray(s.tracks) ? s : null
    } catch {
      return null
    }
  }

  private async saveState(): Promise<void> {
    if (this.tracks.length !== this.opts.tracks.length) return // still preparing
    const state: SavedState = { version: 1, tracks: this.tracks.map((t) => ({ ...t.state })) }
    try {
      const tmp = `${this.statePath}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(state))
      await fsp.rename(tmp, this.statePath)
    } catch {
      /* next tick retries */
    }
  }

  private reportProgress(): void {
    const instant = this.bytesSinceTick / (PROGRESS_INTERVAL_MS / 1000)
    this.bytesSinceTick = 0
    this.speed = this.speed === 0 ? instant : this.speed * 0.7 + instant * 0.3
    const downloaded = this.tracks.reduce((s, t) => s + t.state.bytes, 0)
    // HLS has no byte total up front: estimate each track's size from how much
    // of its duration is done.
    let total: number | null = this.tracks.length ? 0 : null
    for (const t of this.tracks) {
      const done = t.totalDuration > 0 ? t.doneDuration / t.totalDuration : 0
      if (done <= 0 || total === null) total = null
      else total += t.state.bytes / done
    }
    this.opts.onProgress({
      downloaded,
      total: total === null ? null : Math.max(downloaded, Math.round(total)),
      speed: this.speed,
      connections: this.inflight.size,
      reconnecting: this.inflight.size === 0 && this.backingOff > 0 && !this.halted()
    })
  }
}
