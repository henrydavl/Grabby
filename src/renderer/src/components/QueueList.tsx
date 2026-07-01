import { useStore } from '../store'
import { DownloadRow } from './DownloadRow'

export function QueueList(): React.JSX.Element {
  const items = useStore((s) => s.items)

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-center text-slate-500">
        <div className="text-4xl">🎬</div>
        <div className="mt-3 text-sm">No downloads yet</div>
        <div className="mt-1 text-xs">Paste a link above to get started.</div>
      </div>
    )
  }

  // Newest first.
  const ordered = [...items].reverse()

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-y-auto pr-1">
      {ordered.map((item) => (
        <DownloadRow key={item.id} item={item} />
      ))}
    </div>
  )
}
