import { useEffect, useState } from 'react'
import { useStore } from './store'
import { UrlBar } from './components/UrlBar'
import { QueueList } from './components/QueueList'
import { Settings } from './components/Settings'

export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    init()
  }, [init])

  return (
    <div className="flex h-full flex-col">
      {/* Draggable title bar (room for macOS traffic lights). */}
      <div className="titlebar-drag flex items-center justify-between px-4 pb-2 pt-3 pl-20">
        <div className="text-sm font-semibold tracking-wide text-slate-300">Grabby</div>
        <button
          onClick={() => setShowSettings(true)}
          className="no-drag rounded-md px-2 py-1 text-slate-400 transition hover:bg-edge hover:text-white"
          title="Settings"
        >
          ⚙
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-hidden px-4 pb-4">
        <UrlBar />
        <QueueList />
      </div>

      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  )
}
