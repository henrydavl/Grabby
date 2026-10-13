import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DownloadItem, HttpHeaders } from '../shared/types'

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

// Session credentials captured from the browser stay in memory only (never on
// disk). After a relaunch a download resumes without them, so a cookie-gated
// stream has to be sent again from the browser.
const SECRET_HEADERS = new Set(['cookie', 'authorization'])

function withoutSecrets(headers: HttpHeaders | undefined): HttpHeaders | undefined {
  if (!headers) return undefined
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !SECRET_HEADERS.has(name.toLowerCase()))
  )
}

/** Write atomically (temp file + rename) so a crash mid-write can't corrupt the queue. */
export function saveQueue(items: DownloadItem[]): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    const tmp = `${queueFile()}.tmp`
    const safe = items.map((i) => ({
      ...i,
      headers: withoutSecrets(i.headers),
      direct: i.direct && { ...i.direct, headers: withoutSecrets(i.direct.headers) }
    }))
    writeFileSync(tmp, JSON.stringify(safe, null, 2))
    renameSync(tmp, queueFile())
  } catch {
    /* non-fatal */
  }
}
