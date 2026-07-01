import type { FormatKind, FormatOption } from '../../shared/types'

const VIDEO_TIERS: { kind: FormatKind; label: string; height: number }[] = [
  { kind: '2160', label: '4K (2160p)', height: 2160 },
  { kind: '1440', label: '1440p', height: 1440 },
  { kind: '1080', label: '1080p', height: 1080 },
  { kind: '720', label: '720p', height: 720 },
  { kind: '480', label: '480p', height: 480 }
]

/**
 * Build the quality choices for a single video. If we know the available
 * heights, only offer tiers that actually exist (plus Best and Audio).
 */
export function formatOptionsFor(availableHeights?: number[]): FormatOption[] {
  const opts: FormatOption[] = [{ kind: 'best', label: 'Best available' }]

  if (availableHeights && availableHeights.length > 0) {
    const max = Math.max(...availableHeights)
    for (const tier of VIDEO_TIERS) {
      if (tier.height <= max) opts.push({ kind: tier.kind, label: tier.label })
    }
  } else {
    for (const tier of VIDEO_TIERS) opts.push({ kind: tier.kind, label: tier.label })
  }

  opts.push({ kind: 'audio', label: 'Audio only (mp3)' })
  return opts
}

/** Default playlist choices (no per-entry probing). */
export function playlistFormatOptions(): FormatOption[] {
  return [
    { kind: 'best', label: 'Best available' },
    { kind: '1080', label: '1080p' },
    { kind: '720', label: '720p' },
    { kind: 'audio', label: 'Audio only (mp3)' }
  ]
}
