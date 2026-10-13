import { useEffect, useState } from 'react'
import { MAX_AUTO_RETRIES, type DownloadItem, type DownloadStatus } from '../../../shared/types'

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: 'Queued',
  fetching: 'Reading…',
  preparing: 'Preparing…',
  downloading: 'Downloading',
  retrying: 'Retrying',
  paused: 'Paused',
  completed: 'Done',
  error: 'Failed',
  canceled: 'Canceled'
}

const STATUS_COLOR: Record<DownloadStatus, string> = {
  queued: 'text-slate-400',
  fetching: 'text-slate-400',
  preparing: 'text-sky-400',
  downloading: 'text-accent',
  retrying: 'text-amber-400',
  paused: 'text-amber-400',
  completed: 'text-emerald-400',
  error: 'text-red-400',
  canceled: 'text-slate-500'
}

/** Whole seconds until `ts` (epoch ms), ticking once a second; null when unset. */
function useSecondsUntil(ts?: number): number | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!ts) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ts])
  return ts ? Math.max(0, Math.ceil((ts - now) / 1000)) : null
}

function IconBtn({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={label}
      onClick={onClick}
      className="rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-edge hover:text-white"
    >
      {children}
    </button>
  )
}

export function DownloadRow({ item }: { item: DownloadItem }): React.JSX.Element {
  const g = window.grabby
  const active = item.status === 'downloading'
  const preparing = item.status === 'preparing'
  const retrying = item.status === 'retrying'
  const retryIn = useSecondsUntil(retrying ? item.retryAt : undefined)
  const showBar =
    active || preparing || retrying || item.status === 'paused' || item.status === 'completed'

  return (
    <div className="rounded-lg border border-edge bg-panel px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium" title={item.title}>
            {item.kind === 'subtitle' && (
              <span className="flex-shrink-0 rounded bg-edge px-1 py-0.5 text-[10px] font-semibold leading-none text-slate-300">
                SUB
              </span>
            )}
            <span className="truncate">{item.title}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs">
            <span className={STATUS_COLOR[item.status]}>{STATUS_LABEL[item.status]}</span>
            <span className="text-slate-500">· {item.formatLabel}</span>
            {active && item.downloaded && (
              <span className="text-slate-500">
                · {item.downloaded}
                {item.total ? ` / ${item.total}` : ''}
              </span>
            )}
            {active && item.speed && <span className="text-slate-500">· {item.speed}</span>}
            {active && (item.connections ?? 0) > 1 && (
              <span className="text-slate-500" title="Parallel connections">
                · {item.connections} conn
              </span>
            )}
            {active && item.eta && <span className="text-slate-500">· ETA {item.eta}</span>}
            {item.notice && <span className="text-amber-400">· {item.notice}</span>}
            {retrying && !item.notice && retryIn !== null && (
              <span className="text-slate-500">
                · in {retryIn}s (attempt {item.attempt}/{MAX_AUTO_RETRIES})
              </span>
            )}
          </div>
          {(item.status === 'error' || retrying) && item.error && (
            <div
              className={`mt-1 truncate text-xs ${retrying ? 'text-amber-400/70' : 'text-red-400/80'}`}
              title={item.error}
            >
              {item.error}
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          {(active || preparing) && (
            <IconBtn label="Pause" onClick={() => g.pause(item.id)}>⏸</IconBtn>
          )}
          {item.status === 'paused' && (
            <IconBtn label="Resume" onClick={() => g.resume(item.id)}>▶</IconBtn>
          )}
          {(retrying || item.status === 'error') && (
            <IconBtn label={retrying ? 'Retry now' : 'Retry'} onClick={() => g.resume(item.id)}>
              ↻
            </IconBtn>
          )}
          {(active ||
            preparing ||
            retrying ||
            item.status === 'queued' ||
            item.status === 'paused') && (
            <IconBtn label="Cancel" onClick={() => g.cancel(item.id)}>✕</IconBtn>
          )}
          {item.status === 'completed' && (
            <IconBtn label="Show in Finder" onClick={() => g.revealInFinder(item.id)}>
              📂
            </IconBtn>
          )}
          {(item.status === 'completed' ||
            item.status === 'error' ||
            item.status === 'canceled') && (
            <IconBtn label="Remove" onClick={() => g.remove(item.id)}>🗑</IconBtn>
          )}
        </div>
      </div>

      {showBar && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink">
          {preparing ? (
            <div className="grabby-indeterminate h-full w-full" />
          ) : (
            <div
              className={`h-full rounded-full transition-[width] duration-300 ${
                item.status === 'completed' ? 'bg-emerald-500' : 'bg-accent'
              }`}
              style={{ width: `${Math.min(100, Math.max(0, item.percent))}%` }}
            />
          )}
        </div>
      )}
    </div>
  )
}
