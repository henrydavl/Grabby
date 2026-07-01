import { app, shell, BrowserWindow, Tray } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { createTray } from './tray'

let mainWindow: BrowserWindow | null = null
// Kept alive for the lifetime of the app so the OS doesn't GC the tray icon.
let tray: Tray | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Grabby',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Closing the window hides it to the tray instead of quitting; the tray's
  // "Quit Grabby" (or Cmd+Q / before-quit) sets isQuitting to let it through.
  mainWindow.on('close', (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // electron-vite injects the dev server URL in development.
  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const manager = registerIpc(() => mainWindow)
  createWindow()
  tray = createTray(() => mainWindow, manager)

  app.on('activate', () => {
    // Dock/tray click: re-create the window if it was closed, else reveal it.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

// A real quit (Cmd+Q, tray "Quit", app.quit) must bypass the hide-to-tray guard.
app.on('before-quit', () => {
  ;(app as unknown as { isQuitting: boolean }).isQuitting = true
})

// Do nothing here: the app lives in the tray after the window is closed, on all
// platforms. Quit happens via the tray menu or Cmd+Q (before-quit above).
app.on('window-all-closed', () => {})
