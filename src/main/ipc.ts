import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import type { AppSettings, DownloadSpec, HttpHeaders } from '../shared/types'
import { DownloadManager } from './downloadManager'
import { fetchInfo, updateYtdlp, setCookiesBrowser } from './ytdlp'
import { loadSettings, saveSettings } from './settings'
import { startBridge } from './bridge'
import { loadQueue } from './queueStore'

export function registerIpc(getWindow: () => BrowserWindow | null): DownloadManager {
  let settings = loadSettings()
  setCookiesBrowser(settings.cookiesBrowser)
  const manager = new DownloadManager(settings, loadQueue())

  // Forward manager events to the renderer.
  manager.on('progress', (p) => getWindow()?.webContents.send('progress', p))
  manager.on('item', (item) => getWindow()?.webContents.send('item', item))
  manager.on('removed', (id) => getWindow()?.webContents.send('removed', id))

  // Loopback bridge for the browser extension: bring the window forward and hand
  // the candidate URLs to the renderer, which tries them in order then shows the
  // format-picker flow — unless the request is a fresh link for a download whose
  // old one expired, which then simply resumes.
  startBridge((reqData) => {
    const refreshed = manager.refreshFrom(reqData)
    const win = getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      if (!refreshed) win.webContents.send('externalRequest', reqData)
    }
  })

  ipcMain.handle('fetchInfo', (_e, url: string, referer?: string, headers?: HttpHeaders) =>
    fetchInfo(url, referer, headers)
  )

  ipcMain.handle('addDownloads', (_e, specs: DownloadSpec[]) => manager.add(specs))

  ipcMain.handle('pause', (_e, id: string) => manager.pause(id))
  ipcMain.handle('resume', (_e, id: string) => manager.resume(id))
  ipcMain.handle('cancel', (_e, id: string) => manager.cancel(id))
  ipcMain.handle('remove', (_e, id: string) => manager.remove(id))
  ipcMain.handle('getItems', () => manager.list())

  ipcMain.handle('revealInFinder', (_e, id: string) => {
    const fp = manager.getFilePath(id)
    if (fp) shell.showItemInFolder(fp)
  })

  ipcMain.handle('getSettings', () => settings)

  ipcMain.handle('setSettings', (_e, partial: Partial<AppSettings>) => {
    settings = { ...settings, ...partial }
    saveSettings(settings)
    setCookiesBrowser(settings.cookiesBrowser)
    manager.updateSettings(settings)
    return settings
  })

  ipcMain.handle('chooseOutputDir', async () => {
    const win = getWindow()
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.outputDir
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('updateYtdlp', () => updateYtdlp())

  return manager
}
