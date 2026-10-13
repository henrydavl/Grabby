// Human-readable progress strings in the same style yt-dlp prints, so rows look
// the same whichever engine is downloading.

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)}MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(2)}KiB`
  return `${Math.round(n)}B`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const s = Math.round(seconds)
  const hh = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
}
