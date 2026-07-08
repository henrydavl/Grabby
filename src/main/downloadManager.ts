import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import type {
  AppSettings,
  DownloadItem,
  DownloadSpec,
  ProgressUpdate
} from '../shared/types'
import { startDownload, resolveOutputBase } from './ytdlp'
import { startSubtitleDownload, resolveSubtitlePath, subtitleExtFromUrl } from './subs'

interface Runtime {
  child?: ChildProcess
  /** Abort fn for a subtitle (non-child) download. */
  abort?: () => void
  /** True when a non-zero exit was caused by an intentional pause/cancel kill. */
  intentionalStop?: 'paused' | 'canceled'
  /** Highest percent seen this run, so the bar never jumps backward (YouTube
   * downloads video then audio as separate 0→100 passes). */
  maxPercent?: number
}

/**
 * Owns the download queue: enforces a concurrency limit and drives each item's
 * lifecycle. Emits 'progress' (ProgressUpdate) and 'item' (DownloadItem) events
 * which the IPC layer forwards to the renderer.
 */
export class DownloadManager extends EventEmitter {
  private items = new Map<string, DownloadItem>()
  private runtime = new Map<string, Runtime>()
  private order: string[] = []

  constructor(private settings: AppSettings) {
    super()
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
    return created
  }

  pause(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    if (item.status === 'downloading' && rt.child) {
      rt.intentionalStop = 'paused'
      rt.child.kill('SIGTERM')
    } else if (item.status === 'queued') {
      this.patch(id, { status: 'paused' })
    }
  }

  resume(id: string): void {
    const item = this.items.get(id)
    if (!item || item.status !== 'paused') return
    this.patch(id, { status: 'queued' })
    this.pump()
  }

  cancel(id: string): void {
    const item = this.items.get(id)
    const rt = this.runtime.get(id)
    if (!item || !rt) return
    if (item.status === 'downloading' && (rt.child || rt.abort)) {
      rt.intentionalStop = 'canceled'
      rt.child?.kill('SIGTERM')
      rt.abort?.()
    } else {
      this.patch(id, { status: 'canceled' })
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
  }

  getFilePath(id: string): string | undefined {
    return this.items.get(id)?.filePath
  }

  private runningCount(): number {
    return this.list().filter((i) => i.status === 'downloading').length
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

    // "preparing" = process started but no progress yet (metadata extraction +
    // signature solving can take 10–20s before the first byte). The UI shows an
    // indeterminate bar so it doesn't look frozen at 0%.
    rt.maxPercent = 0
    // Resolve a non-clobbering filename once (IDM-style "(1)", "(2)" suffixes),
    // then reuse it across pause/resume so --continue finds its .part file.
    if (!item.outputBase) {
      item.outputBase = resolveOutputBase(item.outputDir, item.title, item.format)
    }
    this.patch(id, { status: 'preparing', percent: 0, speed: '', eta: '', error: undefined })

    const handle = startDownload({
      id,
      url: item.url,
      format: item.format,
      outputDir: item.outputDir,
      outputBase: item.outputBase,
      referer: item.referer,
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
          total: p.total
        })
        this.emit('progress', update)
      }
    })
    rt.child = handle.child

    handle.done.then((res) => {
      rt.child = undefined
      const stop = rt.intentionalStop
      rt.intentionalStop = undefined

      if (stop === 'paused') {
        this.patch(id, { status: 'paused', speed: '', eta: '' })
      } else if (stop === 'canceled') {
        this.patch(id, { status: 'canceled', speed: '', eta: '' })
      } else if (res.code === 0) {
        this.patch(id, {
          status: 'completed',
          percent: 100,
          speed: '',
          eta: '',
          filePath: res.filePath
        })
      } else {
        this.patch(id, { status: 'error', speed: '', eta: '', error: res.error })
      }
      this.pump()
    })
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
      const stop = rt.intentionalStop
      rt.intentionalStop = undefined
      if (stop === 'canceled') {
        this.patch(id, { status: 'canceled', speed: '', eta: '' })
      } else if (res.code === 0) {
        this.patch(id, { status: 'completed', percent: 100, filePath: res.filePath })
      } else {
        this.patch(id, { status: 'error', error: res.error })
      }
      this.pump()
    })
  }

  /** Apply a partial update and emit it. */
  private patch(id: string, partial: Partial<DownloadItem>): void {
    const item = this.items.get(id)
    if (!item) return
    Object.assign(item, partial)
    this.emit('item', { ...item })
  }
}
