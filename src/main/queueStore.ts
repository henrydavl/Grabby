import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DownloadItem } from '../shared/types'

// The download list survives app restarts: interrupted downloads come back as
// paused and resume from their .part files (yt-dlp --continue).

function queueFile(): string {
  return join(app.getPath('userData'), 'queue.json')
}

export function loadQueue(): DownloadItem[] {
  try {
    const parsed = JSON.parse(readFileSync(queueFile(), 'utf-8'))
    return Array.isArray(parsed) ? (parsed as DownloadItem[]) : []
  } catch {
    return []
  }
}

/** Write atomically (temp file + rename) so a crash mid-write can't corrupt the queue. */
export function saveQueue(items: DownloadItem[]): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = `${queueFile()}.tmp`
    writeFileSync(tmp, JSON.stringify(items, null, 2))
    renameSync(tmp, queueFile())
  } catch {
    /* non-fatal */
  }
}
