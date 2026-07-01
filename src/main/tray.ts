import { app, Tray, Menu, nativeImage, BrowserWindow } from 'electron'
import type { DownloadManager } from './downloadManager'
import { TRAY_MAC_16, TRAY_MAC_32, TRAY_WIN_16, TRAY_WIN_32 } from './trayIcon'

const isMac = process.platform === 'darwin'

function trayImage(): Electron.NativeImage {
  const b16 = isMac ? TRAY_MAC_16 : TRAY_WIN_16
  const b32 = isMac ? TRAY_MAC_32 : TRAY_WIN_32
  const img = nativeImage.createFromBuffer(Buffer.from(b16, 'base64'), { scaleFactor: 1 })
  // Provide the @2x representation for Retina / high-DPI menu bars.
  img.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(b32, 'base64')
  })
  // On macOS a template image is auto-tinted to match light/dark menu bars.
  if (isMac) img.setTemplateImage(true)
  return img
}

/** A short label describing current queue activity, shown (disabled) in the menu. */
function statusLabel(manager: DownloadManager): string {
  const items = manager.list()
  const active = items.filter(
    (i) => i.status === 'downloading' || i.status === 'preparing'
  ).length
  const queued = items.filter((i) => i.status === 'queued').length
  if (active === 0 && queued === 0) return 'Idle'
  const parts: string[] = []
  if (active > 0) parts.push(`Downloading ${active}`)
  if (queued > 0) parts.push(`Queued ${queued}`)
  return parts.join(' · ')
}

/**
 * Creates the menu-bar (macOS) / system-tray (Windows/Linux) icon: shows queue
 * status, reveals the window, and quits the app. The window "close" button just
 * hides to the tray (wired in index.ts), so this is the real way out.
 */
export function createTray(getWindow: () => BrowserWindow | null, manager: DownloadManager): Tray {
  const tray = new Tray(trayImage())
  tray.setToolTip('Grabby')

  const show = (): void => {
    const win = getWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  // Rebuild the menu only when the status text actually changes — the manager's
  // 'item' event fires on every progress tick, so blindly calling
  // setContextMenu would thrash the menu many times a second.
  let lastSignature = ''
  const refresh = (): void => {
    const label = statusLabel(manager)
    if (label === lastSignature) return
    lastSignature = label
    const menu = Menu.buildFromTemplate([
      { label: `Grabby — ${label}`, enabled: false },
      { type: 'separator' },
      { label: 'Show Grabby', click: show },
      { type: 'separator' },
      {
        label: 'Quit Grabby',
        click: () => {
          ;(app as unknown as { isQuitting: boolean }).isQuitting = true
          app.quit()
        }
      }
    ])
    tray.setContextMenu(menu)
    tray.setToolTip(label === 'Idle' ? 'Grabby' : `Grabby — ${label}`)
  }

  refresh()
  manager.on('item', refresh)
  manager.on('removed', refresh)

  // On Windows/Linux a left click should open the window (macOS shows the menu).
  if (!isMac) {
    tray.on('click', show)
    tray.on('double-click', show)
  }

  return tray
}
