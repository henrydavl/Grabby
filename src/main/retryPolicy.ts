// Errors where re-running the download can't help: the URL/video itself is bad,
// the content is locked, or the disk can't take the file. Everything else
// (connection resets, timeouts, 5xx, expired signed URLs → 403) is worth retrying,
// since each yt-dlp run re-extracts fresh media URLs.
const FATAL_PATTERNS: RegExp[] = [
  /Unsupported URL/i,
  /is not a valid URL/i,
  /Private video/i,
  /Video unavailable|This video is unavailable|has been removed|account .*terminated/i,
  /DRM/,
  /Requested format is not available/i,
  /Sign in to confirm|members-only|Join this channel|confirm your age/i,
  /No space left on device|ENOSPC|EACCES|Permission denied|Read-only file system/i,
  /ENOENT/ // yt-dlp/ffmpeg binary or output folder missing
]

// 4xx other than these is permanent (404 Not Found, 410 Gone, 401 auth, …).
const RETRYABLE_4XX = new Set([403, 408, 429])

/** True when a failed download is worth re-running automatically. */
export function isRetryable(error: string | undefined): boolean {
  if (!error) return true
  if (FATAL_PATTERNS.some((re) => re.test(error))) return false
  const http = error.match(/HTTP Error (\d{3})|server responded (\d{3})/i)
  if (http) {
    const code = Number(http[1] || http[2])
    if (code >= 400 && code < 500 && !RETRYABLE_4XX.has(code)) return false
  }
  return true
}

/** Backoff before automatic retry number `attempt` (1-based): 5s, 10s, 20s, … capped at 2 min. */
export function retryDelayMs(attempt: number): number {
  return Math.min(5_000 * 2 ** (attempt - 1), 120_000)
}
