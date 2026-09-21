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
 * AVC1 のみの master を組み立てる。URI は `baseUrl` を基準に https の絶対 URL へ解決し、
 * https 以外を指すものは除外する。AVC1 の variant が無ければ null。
 */
export function filterAvc1Master(
  manifest: string,
  baseUrl: string
): string | null {
  const lines = manifest.split(/\r?\n/)
  let best: {
    info: string
    uri: string
    height: number
    bandwidth: number
  } | null = null
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    if (
      !attr(line, 'CODECS')
        ?.split(',')
        .some((c) => c.trim().startsWith('avc1'))
    )
      continue
    const uri = toHttpsUrl(lines[i + 1], baseUrl)
    if (uri === null) continue
    const height = Number(attr(line, 'RESOLUTION')?.split('x', 2)[1] ?? 0)
    const bandwidth = Number(attr(line, 'BANDWIDTH') ?? 0)
    if (
      best === null ||
      height > best.height ||
      (height === best.height && bandwidth > best.bandwidth)
    ) {
      best = { info: line, uri, height, bandwidth }
    }
  }
  if (best === null) return null

  const audioGroup = attr(best.info, 'AUDIO')
  const media: string[] = []
  for (const l of lines) {
    if (
      audioGroup === null ||
      !l.startsWith('#EXT-X-MEDIA:') ||
      attr(l, 'TYPE') !== 'AUDIO' ||
      attr(l, 'GROUP-ID') !== audioGroup
    )
      continue
    const m = /URI="([^"]*)"/.exec(l)
    if (m === null) {
      media.push(l)
      continue
    }
    const uri = toHttpsUrl(m[1], baseUrl)
    if (uri !== null) media.push(l.replace(m[0], () => `URI="${uri}"`))
  }
  return ['#EXTM3U', ...media, best.info, best.uri, ''].join('\n')
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
