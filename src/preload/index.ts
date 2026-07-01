import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  DownloadItem,
  ExternalRequest,
  GrabbyAPI,
  MediaInfo,
  ProgressUpdate
} from '../shared/types'

const api: GrabbyAPI = {
  fetchInfo: (url, referer) =>
    ipcRenderer.invoke('fetchInfo', url, referer) as Promise<MediaInfo>,
  addDownloads: (items) => ipcRenderer.invoke('addDownloads', items) as Promise<DownloadItem[]>,
  pause: (id) => ipcRenderer.invoke('pause', id) as Promise<void>,
  resume: (id) => ipcRenderer.invoke('resume', id) as Promise<void>,
  cancel: (id) => ipcRenderer.invoke('cancel', id) as Promise<void>,
  remove: (id) => ipcRenderer.invoke('remove', id) as Promise<void>,
  revealInFinder: (id) => ipcRenderer.invoke('revealInFinder', id) as Promise<void>,
  getItems: () => ipcRenderer.invoke('getItems') as Promise<DownloadItem[]>,
  getSettings: () => ipcRenderer.invoke('getSettings') as Promise<AppSettings>,
  setSettings: (s: Partial<AppSettings>) =>
    ipcRenderer.invoke('setSettings', s) as Promise<AppSettings>,
  chooseOutputDir: () => ipcRenderer.invoke('chooseOutputDir') as Promise<string | null>,
  updateYtdlp: () =>
    ipcRenderer.invoke('updateYtdlp') as Promise<{ ok: boolean; message: string }>,
  onProgress: (cb: (p: ProgressUpdate) => void) => {
    const listener = (_e: unknown, p: ProgressUpdate): void => cb(p)
    ipcRenderer.on('progress', listener)
    return () => ipcRenderer.removeListener('progress', listener)
  },
  onItemUpdate: (cb: (item: DownloadItem) => void) => {
    const listener = (_e: unknown, item: DownloadItem): void => cb(item)
    ipcRenderer.on('item', listener)
    return () => ipcRenderer.removeListener('item', listener)
  },
  onItemRemoved: (cb: (id: string) => void) => {
    const listener = (_e: unknown, id: string): void => cb(id)
    ipcRenderer.on('removed', listener)
    return () => ipcRenderer.removeListener('removed', listener)
  },
  onExternalRequest: (cb: (req: ExternalRequest) => void) => {
    const listener = (_e: unknown, req: ExternalRequest): void => cb(req)
    ipcRenderer.on('externalRequest', listener)
    return () => ipcRenderer.removeListener('externalRequest', listener)
  }
}

contextBridge.exposeInMainWorld('grabby', api)
