// Minimal HLS media-playlist parser (RFC 8216) covering what VOD downloads need:
// segments, durations, AES-128 keys + IVs, EXT-X-MAP init segments, byte ranges.

export interface ByteRange {
  offset: number
  length: number
}

export interface HlsKey {
  method: string // 'AES-128' (supported) or 'SAMPLE-AES…' (not)
  uri: string
  /** Explicit IV; when absent the segment's media sequence number is used. */
  iv?: Buffer
  keyFormat?: string
}

export interface HlsSegment {
  uri: string
  duration: number
  /** Media sequence number (the default AES-128 IV). */
  seq: number
  range?: ByteRange
  key?: HlsKey
}

export interface MediaPlaylist {
  /** A master playlist (variants) rather than a media playlist. */
  isMaster: boolean
  /** VOD/complete: has EXT-X-ENDLIST or PLAYLIST-TYPE:VOD. */
  complete: boolean
  segments: HlsSegment[]
  /** EXT-X-MAP init segment (fMP4); only one distinct map is supported. */
  map?: { uri: string; range?: ByteRange }
  /** More than one distinct EXT-X-MAP (would need per-period remuxing). */
  multipleMaps: boolean
}

/** Parse `KEY=VALUE,KEY="quoted,value"` attribute lists. */
export function parseAttributes(list: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(list))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2]
  return out
}

function parseRange(spec: string, lastEnd: number): ByteRange {
  const [len, off] = spec.split('@')
  return { length: Number(len), offset: off !== undefined ? Number(off) : lastEnd }
}

function parseIv(hex: string | undefined): Buffer | undefined {
  if (!hex) return undefined
  const clean = hex.replace(/^0x/i, '').padStart(32, '0')
  return /^[0-9a-f]{32}$/i.test(clean) ? Buffer.from(clean, 'hex') : undefined
}

/** IV for a segment: explicit, or its media sequence number as 128-bit big-endian. */
export function segmentIv(seg: HlsSegment): Buffer {
  if (seg.key?.iv) return seg.key.iv
  const iv = Buffer.alloc(16)
  iv.writeBigUInt64BE(BigInt(seg.seq), 8)
  return iv
}

export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const resolve = (uri: string): string => new URL(uri, baseUrl).href
  const playlist: MediaPlaylist = { isMaster: false, complete: false, segments: [], multipleMaps: false }

  let seq = 0
  let duration = 0
  let rangeSpec: string | undefined // EXT-X-BYTERANGE for the next segment
  let key: HlsKey | undefined
  const lastEndByUri = new Map<string, number>()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const colon = line.indexOf(':')
      const tag = colon >= 0 ? line.slice(0, colon) : line
      const value = colon >= 0 ? line.slice(colon + 1) : ''
      switch (tag) {
        case '#EXT-X-STREAM-INF':
          playlist.isMaster = true
          break
        case '#EXT-X-MEDIA-SEQUENCE':
          seq = Number(value) || 0
          break
        case '#EXT-X-ENDLIST':
          playlist.complete = true
          break
        case '#EXT-X-PLAYLIST-TYPE':
          if (value.trim() === 'VOD') playlist.complete = true
          break
        case '#EXTINF':
          duration = parseFloat(value) || 0
          break
        case '#EXT-X-BYTERANGE':
          rangeSpec = value
          break
        case '#EXT-X-KEY': {
          const a = parseAttributes(value)
          key =
            a.METHOD && a.METHOD !== 'NONE'
              ? { method: a.METHOD, uri: a.URI ? resolve(a.URI) : '', iv: parseIv(a.IV), keyFormat: a.KEYFORMAT }
              : undefined
          break
        }
        case '#EXT-X-MAP': {
          const a = parseAttributes(value)
          if (!a.URI) break
          const uri = resolve(a.URI)
          const mapRange = a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : undefined
          if (
            playlist.map &&
            (playlist.map.uri !== uri || playlist.map.range?.offset !== mapRange?.offset)
          ) {
            playlist.multipleMaps = true
          }
          playlist.map ??= { uri, range: mapRange }
          break
        }
      }
      continue
    }
    // A URI line: the segment the preceding tags describe.
    const uri = resolve(line)
    const seg: HlsSegment = { uri, duration, seq, key }
    if (rangeSpec) {
      // Without an explicit offset, a range continues where the last one on this URI ended.
      seg.range = parseRange(rangeSpec, lastEndByUri.get(uri) ?? 0)
      lastEndByUri.set(uri, seg.range.offset + seg.range.length)
    }
    playlist.segments.push(seg)
    seq++
    duration = 0
    rangeSpec = undefined
  }
  return playlist
}
