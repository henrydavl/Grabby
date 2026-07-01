import { useState } from 'react'
import type { FormatKind, FormatOption, MediaInfo } from '../../../shared/types'
import { formatOptionsFor, playlistFormatOptions } from '../formats'

interface Props {
  info: MediaInfo
  onConfirm: (format: FormatKind, label: string) => void
  onCancel: () => void
}

/** Human-readable, approximate size label (e.g. "~42 MB"). Empty if unknown. */
function sizeLabel(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `~${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function FormatPicker({ info, onConfirm, onCancel }: Props): React.JSX.Element {
  const options: FormatOption[] = info.isPlaylist
    ? playlistFormatOptions()
    : formatOptionsFor(info.availableHeights)
  const [selected, setSelected] = useState<FormatOption>(options[0])

  const count = info.entries?.length ?? 1

  const sizeFor = (kind: FormatKind): string => {
    if (info.isPlaylist) return '' // per-entry size unknown for playlists
    if (kind === 'best') return sizeLabel(info.bestSize)
    if (kind === 'audio') return sizeLabel(info.audioSize)
    return sizeLabel(info.sizeByHeight?.[Number(kind)])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 no-drag">
      <div className="w-[440px] rounded-xl border border-edge bg-panel p-5 shadow-2xl">
        <div className="flex gap-3">
          {info.thumbnail && (
            <img
              src={info.thumbnail}
              alt=""
              className="h-16 w-28 flex-shrink-0 rounded object-cover"
            />
          )}
          <div className="min-w-0">
            <div className="truncate font-medium" title={info.title}>
              {info.title}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              {info.isPlaylist ? `Playlist · ${count} videos` : info.durationString || 'Video'}
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-1.5">
          {options.map((opt) => (
            <button
              key={opt.kind}
              onClick={() => setSelected(opt)}
              className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                selected.kind === opt.kind
                  ? 'border-accent bg-accent/10 text-white'
                  : 'border-edge bg-ink/40 text-slate-300 hover:border-slate-500'
              }`}
            >
              <span>{opt.label}</span>
              <span className="flex items-center gap-2">
                {sizeFor(opt.kind) && (
                  <span className="text-xs text-slate-500">{sizeFor(opt.kind)}</span>
                )}
                {selected.kind === opt.kind && <span className="text-accent">●</span>}
              </span>
            </button>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(selected.kind, selected.label)}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
          >
            {info.isPlaylist ? `Download ${count}` : 'Download'}
          </button>
        </div>
      </div>
    </div>
  )
}
