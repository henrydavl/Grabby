// electron-builder afterPack hook (macOS).
//
// 1. Strip Chromium's locale packs except English. The UI is English-only, and
//    Electron 44 ships ~220 .lproj folders (incl. gendered variants) that
//    `electronLanguages` doesn't remove from the framework — ~48 MB.
// 2. Ad-hoc sign the whole bundle. Builds are unsigned (identity: null), so
//    electron-builder leaves Electron's stock linker signature, whose resource
//    seal no longer matches once files change. A consistent ad-hoc signature
//    keeps "right-click → Open" working on Apple Silicon.
const { execFileSync } = require('child_process')
const { readdirSync, rmSync, existsSync } = require('fs')
const { join } = require('path')

const KEEP = new Set(['en.lproj'])

function stripLocales(dir) {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.lproj') && !KEEP.has(name)) {
      rmSync(join(dir, name), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const removed =
    stripLocales(join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources')) +
    stripLocales(join(app, 'Contents/Resources'))
  console.log(`  • afterPack: removed ${removed} locale folders`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  console.log('  • afterPack: ad-hoc signed', app)
}
