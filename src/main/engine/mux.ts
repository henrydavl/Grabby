import { spawn, type ChildProcess } from 'child_process'
import { promises as fsp } from 'fs'
import { EngineError } from './errors'

/**
 * Copy-only ffmpeg remux of downloaded track(s) into one file: MP4 (with
 * +faststart) when the codecs fit, else MKV. Writes to a temp name and renames,
 * so a half-written file never shows up under the final name.
 */
export class Remuxer {
  private child: ChildProcess | null = null
  private killed = false

  constructor(private readonly ffmpeg: string) {}

  kill(): void {
    this.killed = true
    this.child?.kill('SIGTERM')
  }

  /** Returns the path written: `${stem}.mp4` or `${stem}.mkv`. */
  async run(inputs: string[], stem: string): Promise<string> {
    const args = inputs.flatMap((p) => ['-i', p])
    // Only audio/video: timed-ID3 / data streams can't go into MP4.
    const maps = inputs.flatMap((_, i) => ['-map', `${i}:v?`, '-map', `${i}:a?`])
    const attempts: [string, string[]][] = [
      ['mp4', ['-movflags', '+faststart']],
      ['mkv', []] // codecs MP4 can't carry
    ]
    let lastError = ''
    for (const [ext, extra] of attempts) {
      const out = `${stem}.${ext}`
      const tmp = `${stem}.grabby-mux.${ext}`
      try {
        await this.exec([...args, ...maps, '-c', 'copy', ...extra, tmp])
        await fsp.rename(tmp, out)
        return out
      } catch (e) {
        await fsp.rm(tmp, { force: true })
        if (this.killed) throw new EngineError('stopped', 'transient')
        lastError = e instanceof Error ? e.message : String(e)
      }
    }
    throw new EngineError(`remux failed: ${lastError}`, 'fallback')
  }

  private exec(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        windowsHide: true
      })
      this.child = child
      let stderr = ''
      child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()))
      child.on('error', reject)
      child.on('close', (code) => {
        this.child = null
        if (code === 0) resolve()
        else reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
      })
    })
  }
}
