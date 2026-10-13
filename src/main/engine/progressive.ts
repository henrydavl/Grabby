import { existsSync, promises as fsp } from 'fs'
import type { HttpHeaders } from '../../shared/types'
import type { CookieEntry } from './http'
import { Remuxer } from './mux'
import { SegmentedDownload, type EngineProgress, type EngineResult } from './segmented'

/**
 * Plain HTTP formats through the segmented engine. One format is downloaded
 * straight to `${stem}.${ext}`; separate video + audio formats (what yt-dlp
 * would merge) are downloaded in parallel and remuxed into one file.
 */

export interface ProgressiveTrack {
  url: string
  ext: string
  headers: HttpHeaders
  cookies?: CookieEntry[]
}

export interface ProgressiveOptions {
  /** Video first, then a separate audio track if any. */
  tracks: ProgressiveTrack[]
  credentialHost: string | null
  /** Output path without extension. */
  destStem: string
  ffmpeg: string
  connections: number
  onProgress: (p: EngineProgress) => void
}

export class ProgressiveDownload {
  private jobs: SegmentedDownload[] = []
  private readonly remuxer: Remuxer
  private stopped = false

  constructor(private opts: ProgressiveOptions) {
    this.remuxer = new Remuxer(opts.ffmpeg)
  }

  stop(): void {
    this.stopped = true
    for (const j of this.jobs) j.stop()
    this.remuxer.kill()
  }

  async run(): Promise<EngineResult> {
    const { tracks, destStem } = this.opts
    if (tracks.length === 1) {
      return this.job(tracks[0], `${destStem}.${tracks[0].ext}`, this.opts.connections, this.opts.onProgress).run()
    }

    // Video gets most connections; the (much smaller) audio track a quarter.
    const audioConns = Math.max(1, Math.round(this.opts.connections / 4))
    const budget = [Math.max(1, this.opts.connections - audioConns), ...tracks.slice(1).map(() => audioConns)]
    const progress: (EngineProgress | null)[] = tracks.map(() => null)
    const paths = tracks.map((t, i) => `${destStem}.f${i}.${t.ext}`)

    const results = await Promise.all(
      tracks.map(async (t, i): Promise<EngineResult> => {
        // Finished on an earlier run (the other track failed or was paused).
        if (existsSync(paths[i]) && !existsSync(`${paths[i]}.grabby-state.json`)) {
          return { code: 0, filePath: paths[i] }
        }
        const job = this.job(t, paths[i], budget[i], (p) => {
          progress[i] = p
          this.opts.onProgress(aggregate(progress))
        })
        const res = await job.run()
        // One track can't finish: stop the other (it keeps its progress).
        if (res.code !== 0 && !this.stopped) this.stopAllJobs()
        return res
      })
    )

    if (this.stopped) return { code: 1, error: 'stopped' }
    const failed = results.find((r) => r.code !== 0 && r.error !== 'stopped') ?? results.find((r) => r.code !== 0)
    if (failed) {
      if (failed.fallback) await this.removeTemp(paths)
      return failed
    }
    try {
      const filePath = await this.remuxer.run(paths, destStem)
      await this.removeTemp(paths)
      return { code: 0, filePath }
    } catch (e) {
      if (this.stopped) return { code: 1, error: 'stopped' }
      const err = e as { message?: string; kind?: string }
      if (err.kind === 'fallback') await this.removeTemp(paths)
      return { code: 1, error: err.message ?? String(e), fallback: err.kind === 'fallback' }
    }
  }

  private job(
    track: ProgressiveTrack,
    destPath: string,
    connections: number,
    onProgress: (p: EngineProgress) => void
  ): SegmentedDownload {
    const job = new SegmentedDownload({
      url: track.url,
      headers: track.headers,
      credentialHost: this.opts.credentialHost,
      cookies: track.cookies,
      destPath,
      connections,
      onProgress
    })
    this.jobs.push(job)
    return job
  }

  private stopAllJobs(): void {
    for (const j of this.jobs) j.stop()
  }

  private async removeTemp(paths: string[]): Promise<void> {
    for (const p of paths) {
      await fsp.rm(p, { force: true })
      await fsp.rm(`${p}.grabby-part`, { force: true })
      await fsp.rm(`${p}.grabby-state.json`, { force: true })
    }
  }
}

function aggregate(parts: (EngineProgress | null)[]): EngineProgress {
  const known = parts.filter((p): p is EngineProgress => p !== null)
  const allSized = known.length === parts.length && known.every((p) => p.total !== null)
  return {
    downloaded: known.reduce((s, p) => s + p.downloaded, 0),
    total: allSized ? known.reduce((s, p) => s + (p.total ?? 0), 0) : null,
    speed: known.reduce((s, p) => s + p.speed, 0),
    connections: known.reduce((s, p) => s + p.connections, 0),
    reconnecting: known.length > 0 && known.every((p) => p.connections === 0) && known.some((p) => p.reconnecting)
  }
}
