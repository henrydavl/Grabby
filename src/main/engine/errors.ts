// Error classification shared by Grabby's download engines.
//  transient — retry (connection reset, stall, 5xx, …)
//  throttled — the host wants fewer/slower requests (429/503)
//  fallback  — this engine can't fetch it (blocked, not media, DRM…): hand to yt-dlp
//  fatal     — retrying can't help (404, disk full, …)

export type ErrorKind = 'transient' | 'fatal' | 'fallback' | 'throttled'

export class EngineError extends Error {
  constructor(
    message: string,
    public kind: ErrorKind,
    public retryAfterMs?: number
  ) {
    super(message)
  }
}

export function httpError(status: number, retryAfter?: string): EngineError {
  if (status === 429 || status === 503) {
    const secs = Number(retryAfter)
    return new EngineError(`HTTP Error ${status}`, 'throttled', secs > 0 ? secs * 1000 : undefined)
  }
  if (status === 401 || status === 403 || status === 410) {
    // Often a TLS-fingerprint / bot block that yt-dlp's impersonation gets past,
    // or a per-connection limit / expired link (decided by the caller from context).
    return new EngineError(`HTTP Error ${status}`, 'fallback')
  }
  if (status >= 500) return new EngineError(`HTTP Error ${status}`, 'transient')
  return new EngineError(`HTTP Error ${status}`, 'fatal')
}

export function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineError) return e
  const msg = e instanceof Error ? e.message : String(e)
  if (/ENOSPC|EACCES|EROFS|EPERM/.test(msg)) return new EngineError(msg, 'fatal')
  return new EngineError(msg || 'connection error', 'transient')
}

/** True for 401/403/410 — after data has flowed these mean "expired", not "blocked". */
export function isAuthError(err: EngineError): boolean {
  return /^HTTP Error (401|403|410)/.test(err.message)
}

/** Backoff for retry number `attempts` (1-based): 1s, 2s, 4s, … capped at 30s. */
export function retryDelay(attempts: number): number {
  return Math.min(1_000 * 2 ** (attempts - 1), 30_000)
}
