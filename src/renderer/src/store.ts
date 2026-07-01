import { create } from 'zustand'
import type { AppSettings, DownloadItem, ProgressUpdate } from '../../shared/types'

interface State {
  items: DownloadItem[]
  settings: AppSettings | null
  init: () => Promise<void>
  upsertItem: (item: DownloadItem) => void
  removeItem: (id: string) => void
  applyProgress: (p: ProgressUpdate) => void
  refreshItems: () => Promise<void>
  setSettings: (s: AppSettings) => void
}

export const useStore = create<State>((set, get) => ({
  items: [],
  settings: null,

  init: async () => {
    const [items, settings] = await Promise.all([
      window.grabby.getItems(),
      window.grabby.getSettings()
    ])
    set({ items, settings })

    window.grabby.onItemUpdate((item) => get().upsertItem(item))
    window.grabby.onItemRemoved((id) => get().removeItem(id))
    window.grabby.onProgress((p) => get().applyProgress(p))
  },

  upsertItem: (item) =>
    set((s) => {
      const idx = s.items.findIndex((i) => i.id === item.id)
      if (idx === -1) return { items: [...s.items, item] }
      const next = s.items.slice()
      next[idx] = item
      return { items: next }
    }),

  removeItem: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),

  applyProgress: (p) =>
    set((s) => {
      const idx = s.items.findIndex((i) => i.id === p.id)
      if (idx === -1) return s
      const next = s.items.slice()
      next[idx] = {
        ...next[idx],
        percent: p.percent,
        speed: p.speed,
        eta: p.eta,
        downloaded: p.downloaded,
        total: p.total,
        status: 'downloading'
      }
      return { items: next }
    }),

  refreshItems: async () => set({ items: await window.grabby.getItems() }),

  setSettings: (settings) => set({ settings })
}))
