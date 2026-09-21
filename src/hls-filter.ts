/** `#EXT-X-STREAM-INF` などのタグ行から属性値 (引用符付き/なし) を取り出す。 */
function attr(line: string, name: string): string | null {
  const m = new RegExp(`[:,]${name}=("([^"]*)"|[^,]*)`).exec(line)
  return m ? m[2] || m[1] : null
}

/**
 * URI を master の URL を基準に絶対 URL へ解決し、https のものだけ返す。ffmpeg にはローカルの
 * `input.m3u8` として渡すため、相対 URI はそのままでは解決できず、file: などの他スキームは
 * 読み取り先を意図せず広げてしまう。
 */
function toHttpsUrl(uri: string, baseUrl: string): string | null {
  try {
    const url = new URL(uri, baseUrl)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * HLS master manifest を、最高画質の AVC1 (H.264) variant 1 本と、その variant が参照する
 * 音声グループの `#EXT-X-MEDIA` だけに絞る。YouTube の VOD の master は音声が別 rendition
 * (`EXT-X-MEDIA`) になっており、AVC1 variant は映像のみのため、variant の URL を単体で返すと
 * 音声が失われる。master のまま返すと VP9 / fMP4 の variant が選ばれ得る (VRChat/AVPro の既知の不具合) ため、
 * AVC1 のみの master を組み立てる。音声を再生できない variant (音声グループに有効な rendition が無い、
 * または音声グループも音声コーデックも持たない) は選ばない。URI は `baseUrl` を基準に https の絶対 URL へ
 * 解決し、https 以外を指すものは除外する。条件を満たす AVC1 の variant が無ければ null。
 */
export function filterAvc1Master(
  manifest: string,
  baseUrl: string
): string | null {
  const lines = manifest.split(/\r?\n/)

  // 音声グループごとの有効な `#EXT-X-MEDIA` (URI が https に解決できるもの、または URI を持たないもの)。
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

    // 音声を再生できない variant は選ばない (無音の HLS を作らないため)。音声グループを参照する variant は
    // そのグループに有効な rendition があること、参照しない variant は映像と同じストリームに音声 (mp4a) を含むこと。
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
 * master manifest を取得して {@link filterAvc1Master} で絞り込む。取得失敗・タイムアウトは例外、
 * AVC1 の variant が無ければ null。
 */
export async function fetchAvc1Master(
  url: string,
  timeoutMs: number
): Promise<string | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} fetching HLS master`)
  return filterAvc1Master(await res.text(), url)
}
