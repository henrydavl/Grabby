import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { AppSettings } from '../shared/types'

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function defaults(): AppSettings {
  return {
    outputDir: app.getPath('downloads'),
    maxConcurrent: 3,
    cookiesBrowser: 'none'
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw = readFileSync(settingsFile(), 'utf-8')
    return { ...defaults(), ...JSON.parse(raw) }
  } catch {
    return defaults()
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    if (!existsSync(s.outputDir)) s.outputDir = app.getPath('downloads')
    writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
  } catch {
    /* non-fatal */
  }
}
