// Renders build/icon.svg to build/icon.png (1024×1024, transparent) using
// Electron's own Chromium, so no SVG tooling has to be installed. electron-builder
// converts build/icon.png into the macOS .icns and Windows .ico at package time.
//
//   npx electron scripts/gen-app-icon.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('fs')
const { join } = require('path')

const SIZE = 1024
const root = join(__dirname, '..')

app.disableHardwareAcceleration()
app.dock?.hide()

app.whenReady().then(async () => {
  const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8')
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })
  win.webContents.setFrameRate(1)
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 500)) // let filters paint
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE })
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' })
  writeFileSync(join(root, 'build', 'icon.png'), image.toPNG())
  console.log('wrote build/icon.png', image.getSize())
  app.quit()
})
