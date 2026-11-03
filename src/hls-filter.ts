/** Extracts an attribute value (quoted or not) from a tag line such as `#EXT-X-STREAM-INF`. */
export function attr(line: string, name: string): string | null {
  const m = new RegExp(`[:,]${name}=("([^"]*)"|[^,]*)`).exec(line)
  return m ? m[2] || m[1] : null
}

/**
 * Resolves a URI against the playlist URL and returns it only if https. Other schemes such as
 * file: are rejected because they would unintentionally widen what the server reads.
 */
export function toHttpsUrl(uri: string, baseUrl: string): string | null {
  try {
    const url = new URL(uri, baseUrl)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Narrows an HLS master manifest to the single highest-quality AVC1 (H.264) variant plus the
 * audio group's `#EXT-X-MEDIA` it references. YouTube VOD masters carry audio as a separate
 * rendition (`EXT-X-MEDIA`) and the AVC1 variant is video-only, so returning just the variant URL
 * would lose audio; returning the master as-is may let VRChat/AVPro pick a VP9 / fMP4 variant
 * (a known bug). So an AVC1-only master is built. Variants that can't play audio (no valid
 * rendition in the audio group, or neither an audio group nor an audio codec) are never chosen.
 * URIs are resolved to absolute https URLs against `baseUrl`; non-https ones are dropped.
 * Returns null if no suitable AVC1 variant exists.
 */
export function filterAvc1Master(
  manifest: string,
  baseUrl: string
): string | null {
  const lines = manifest.split(/\r?\n/)

  // Valid `#EXT-X-MEDIA` per audio group (URI resolves to https, or has no URI).
  const audioMedia = new Map<string, string[]>()
  for (const l of lines) {
    if (!l.startsWith('#EXT-X-MEDIA:') || attr(l, 'TYPE') !== 'AUDIO') continue
    const group = attr(l, 'GROUP-ID')
    if (group === null) continue
    const m = /URI="([^"]*)"/.exec(l)
    let media = l
    if (m !== null) {
      const uri = toHttpsUrl(m[1], baseUrl)
      if (uri === null) continue
      media = l.replace(m[0], () => `URI="${uri}"`)
    }
    audioMedia.set(group, [...(audioMedia.get(group) ?? []), media])
  }

  let best: {
    info: string
    uri: string
    media: string[]
    height: number
    bandwidth: number
  } | null = null
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    const codecs = attr(line, 'CODECS')?.split(',') ?? []
    if (codecs.every((c) => !c.trim().startsWith('avc1'))) continue
    const uri = toHttpsUrl(lines[i + 1], baseUrl)
    if (uri === null) continue

    // Skip variants that can't play audio (to avoid silent HLS): one referencing an audio group
    // needs a valid rendition in it; one without a group needs audio (mp4a) in the same stream.
    const group = attr(line, 'AUDIO')
    const media = group === null ? [] : (audioMedia.get(group) ?? [])
    const hasAudio =
      group === null
        ? codecs.some((c) => c.trim().startsWith('mp4a'))
        : media.length > 0
    if (!hasAudio) continue

    const height = Number(attr(line, 'RESOLUTION')?.split('x', 2)[1] ?? 0)
    const bandwidth = Number(attr(line, 'BANDWIDTH') ?? 0)
    if (
      best === null ||
      height > best.height ||
      (height === best.height && bandwidth > best.bandwidth)
    ) {
      best = { info: line, uri, media, height, bandwidth }
    }
  }
  if (best === null) return null

  return ['#EXTM3U', ...best.media, best.info, best.uri, ''].join('\n')
}

/**
 * Fetches the master manifest and narrows it with {@link filterAvc1Master}. Throws on fetch
 * failure or timeout; returns null if there is no AVC1 variant.
 */
export async function fetchAvc1Master(
  url: string,
  timeoutMs: number
): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} fetching HLS master`)
  return filterAvc1Master(await res.text(), url)
}
