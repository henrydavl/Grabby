import { useState } from 'react'
import type { CookiesBrowser } from '../../../shared/types'
import { useStore } from '../store'

const BROWSERS: { value: CookiesBrowser; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'safari', label: 'Safari' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'zen', label: 'Zen' },
  { value: 'brave', label: 'Brave' },
  { value: 'edge', label: 'Edge' }
]

export function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const [updating, setUpdating] = useState(false)
  const [updateMsg, setUpdateMsg] = useState<string | null>(null)

  if (!settings) return <></>

  const chooseDir = async (): Promise<void> => {
    const dir = await window.grabby.chooseOutputDir()
    if (dir) setSettings(await window.grabby.setSettings({ outputDir: dir }))
  }

  const setConcurrent = async (n: number): Promise<void> => {
    setSettings(await window.grabby.setSettings({ maxConcurrent: n }))
  }

  const setCookies = async (b: CookiesBrowser): Promise<void> => {
    setSettings(await window.grabby.setSettings({ cookiesBrowser: b }))
  }

  const updateYtdlp = async (): Promise<void> => {
    setUpdating(true)
    setUpdateMsg(null)
    const res = await window.grabby.updateYtdlp()
    setUpdateMsg(res.message)
    setUpdating(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 no-drag">
      <div className="w-[460px] rounded-xl border border-edge bg-panel p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            ✕
          </button>
        </div>

        <label className="block text-xs text-slate-400">Download folder</label>
        <div className="mt-1 flex gap-2">
          <input
            readOnly
            value={settings.outputDir}
            className="flex-1 truncate rounded-lg border border-edge bg-ink px-3 py-2 text-sm text-slate-300"
          />
          <button
            onClick={chooseDir}
            className="rounded-lg border border-edge px-3 py-2 text-sm hover:border-slate-500"
          >
            Choose…
          </button>
        </div>

        <label className="mt-4 block text-xs text-slate-400">Simultaneous downloads</label>
        <div className="mt-1 flex gap-2">
          {[1, 2, 3, 5].map((n) => (
            <button
              key={n}
              onClick={() => setConcurrent(n)}
              className={`rounded-lg border px-4 py-1.5 text-sm ${
                settings.maxConcurrent === n
                  ? 'border-accent bg-accent/10 text-white'
                  : 'border-edge text-slate-300 hover:border-slate-500'
              }`}
            >
              {n}
            </button>
          ))}
        </div>

        <label className="mt-4 block text-xs text-slate-400">
          Use cookies from browser{' '}
          <span className="text-slate-500">(required for YouTube)</span>
        </label>
        <div className="mt-1 flex flex-wrap gap-2">
          {BROWSERS.map((b) => (
            <button
              key={b.value}
              onClick={() => setCookies(b.value)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                settings.cookiesBrowser === b.value
                  ? 'border-accent bg-accent/10 text-white'
                  : 'border-edge text-slate-300 hover:border-slate-500'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-slate-500">
          Pick the browser where you&apos;re signed in to YouTube. Cookies are read locally and
          passed only to yt-dlp.
        </p>

        <div className="mt-5 border-t border-edge pt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm">Update yt-dlp</div>
              <div className="text-xs text-slate-500">Fixes sites that stopped working.</div>
            </div>
            <button
              onClick={updateYtdlp}
              disabled={updating}
              className="rounded-lg border border-edge px-3 py-1.5 text-sm hover:border-slate-500 disabled:opacity-40"
            >
              {updating ? 'Updating…' : 'Update'}
            </button>
          </div>
          {updateMsg && (
            <pre className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-ink p-2 text-xs text-slate-400">
              {updateMsg}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
