import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from './config'
import { KeyedMutex } from './lock'
import { logger } from './logger'
import { downloadVideo } from './ytdlp'

/** Cache の同時ダウンロードを videoId 単位で直列化する ("proxy" モードで同じ動画への同時要求が二重ダウンロードするのを防ぐ)。 */
const downloadMutex = new KeyedMutex()

/** videoId ごとにディスクへ永続化するキャッシュエントリのメタデータ。 */
interface CacheEntryMeta {
  videoId: string
  sizeBytes: number
  /** 動画ファイルを最後にダウンロード (更新) した時刻。TTL 判定に使う。 */
  downloadedAt: number
  /** 最後にキャッシュヒットとして参照された時刻。LRU 削除の判定に使う。 */
  lastAccessedAt: number
}

function cacheFilePath(cacheDir: string, videoId: string): string {
  return path.join(cacheDir, `${encodeURIComponent(videoId)}.mp4`)
}

function cacheMetaPath(cacheDir: string, videoId: string): string {
  return path.join(cacheDir, `${encodeURIComponent(videoId)}.meta.json`)
}

/**
 * tmp ファイルへ書いてから rename する。同一ボリューム上の rename は atomic なので、
 * 読み手が書きかけの内容を見ることはない (manifest-store.ts の writeFileAtomic と同じ方針)。
 */
function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

function loadMeta(cacheDir: string, videoId: string): CacheEntryMeta | null {
  const file = cacheMetaPath(cacheDir, videoId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntryMeta
  } catch {
    // 破損したメタデータはキャッシュミス扱いにして再ダウンロードで復旧させる。
    return null
  }
}

function persistMeta(cacheDir: string, meta: CacheEntryMeta): void {
  writeFileAtomic(
    cacheMetaPath(cacheDir, meta.videoId),
    JSON.stringify(meta, null, 2)
  )
}

/** cacheDir 配下の全メタデータを読み込む。Directory が存在しない場合は空配列を返す。 */
function listAllMeta(cacheDir: string): CacheEntryMeta[] {
  if (!fs.existsSync(cacheDir)) return []
  const entries: CacheEntryMeta[] = []
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith('.meta.json')) continue
    try {
      entries.push(
        JSON.parse(
          fs.readFileSync(path.join(cacheDir, name), 'utf8')
        ) as CacheEntryMeta
      )
    } catch {
      // 破損したメタデータは容量計算・削除対象選定から除外する (壊れたファイル自体は残るが実害は小さい)。
    }
  }
  return entries
}

/**
 * キャッシュ総容量が maxBytes を超えている場合に、最終アクセスが古い順に削除すべき videoId を選ぶ純粋関数。
 * 超えていなければ空配列を返す。
 */
export function selectEvictions(
  entries: CacheEntryMeta[],
  maxBytes: number
): string[] {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  if (totalBytes <= maxBytes) return []

  const sortedByLru = entries.toSorted(
    (a, b) => a.lastAccessedAt - b.lastAccessedAt
  )
  const evictVideoIds: string[] = []
  let remaining = totalBytes
  for (const entry of sortedByLru) {
    if (remaining <= maxBytes) break
    evictVideoIds.push(entry.videoId)
    remaining -= entry.sizeBytes
  }
  return evictVideoIds
}

function runEviction(cacheDir: string, maxBytes: number): void {
  const evictVideoIds = selectEvictions(listAllMeta(cacheDir), maxBytes)
  for (const videoId of evictVideoIds) {
    try {
      fs.rmSync(cacheFilePath(cacheDir, videoId), { force: true })
      fs.rmSync(cacheMetaPath(cacheDir, videoId), { force: true })
      logger.info(
        `evicted cached video ${videoId} (LRU, cache size exceeded MEDIA_CACHE_MAX_BYTES)`
      )
    } catch (err) {
      logger.warn(
        `failed to evict cached video ${videoId}: ${(err as Error).message}`
      )
    }
  }
}

/** メタデータとファイルの両方が揃っていて、かつ TTL 内かどうかを判定する。 */
function isFresh(
  meta: CacheEntryMeta | null,
  filePath: string,
  ttlMs: number,
  now: number
): meta is CacheEntryMeta {
  if (!meta) return false
  if (!fs.existsSync(filePath)) return false
  return now - meta.downloadedAt < ttlMs
}

/**
 * videoId に対応するキャッシュ済み動画ファイルが TTL (`mediaCacheTtlMs`) 内で新鮮な場合のみ、
 * ダウンロードを起動せずにその絶対パスを返す。新鮮でなければ `null` を返す
 * ("hybrid" 配信モードが redirect にフォールバックすべきか判定するために使う)。
 */
export function peekFreshCache(
  config: AppConfig,
  videoId: string
): string | null {
  const filePath = cacheFilePath(config.mediaCacheDir, videoId)
  const now = Date.now()
  const meta = loadMeta(config.mediaCacheDir, videoId)
  if (!isFresh(meta, filePath, config.mediaCacheTtlMs, now)) return null
  persistMeta(config.mediaCacheDir, { ...meta, lastAccessedAt: now })
  return filePath
}

/**
 * videoId をダウンロードしてキャッシュに配置し、その絶対パスを返す。
 * 呼び出し側で新鮮なキャッシュが無いことを確認済みである前提で、{@link peekFreshCache} による
 * 判定を経ずに直接ミューテックス取得へ進む ({@link triggerBackgroundDownload} が既に
 * {@link peekFreshCache} 済みの videoId に対してこれを二重に呼ばず即座に応答を返せるようにするため)。
 *
 * 同一 videoId への同時呼び出しは {@link downloadMutex} で直列化され、二重ダウンロードは起きない。
 */
async function downloadAndCache(
  config: AppConfig,
  videoId: string
): Promise<string> {
  const filePath = cacheFilePath(config.mediaCacheDir, videoId)

  return downloadMutex.run(videoId, async () => {
    // Mutex 取得待ちの間に別の呼び出しが先にダウンロードを終えている可能性があるため再チェックする。
    const recheckFresh = peekFreshCache(config, videoId)
    if (recheckFresh) return recheckFresh

    fs.mkdirSync(config.mediaCacheDir, { recursive: true })
    await downloadVideo(videoId, filePath, {
      ytdlpPath: config.ytdlpPath,
      timeoutMs: config.mediaDownloadTimeoutMs,
      maxHeight: config.mediaMaxHeight,
    })

    const stat = fs.statSync(filePath)
    const downloadedAt = Date.now()
    const newMeta: CacheEntryMeta = {
      videoId,
      sizeBytes: stat.size,
      downloadedAt,
      lastAccessedAt: downloadedAt,
    }
    persistMeta(config.mediaCacheDir, newMeta)
    logger.info(`cached video ${videoId} (${stat.size} bytes)`)

    runEviction(config.mediaCacheDir, config.mediaCacheMaxBytes)
    return filePath
  })
}

/**
 * videoId に対応するキャッシュ済み動画ファイルの絶対パスを返す。
 * キャッシュが無い、または TTL (`mediaCacheTtlMs`) を過ぎている場合は yt-dlp で再ダウンロードしてから返す
 * ("proxy" 配信モードの Media Endpoint はこの結果を `res.sendFile()` で配信する)。
 */
export async function getOrDownload(
  config: AppConfig,
  videoId: string
): Promise<string> {
  const fresh = peekFreshCache(config, videoId)
  if (fresh) return fresh
  return downloadAndCache(config, videoId)
}

/**
 * videoId のダウンロードを開始するが、完了を待たずに即座に返る ("hybrid" 配信モードが
 * redirect フォールバック応答を先に返しつつ、裏で最新版を取得しておくために使う)。
 * 呼び出し元は既に {@link peekFreshCache} で新鮮なキャッシュが無いことを確認済みのため、
 * 判定を再実行せず直接 {@link downloadAndCache} を呼ぶ (302 応答前の同期的な fs アクセスを避けるため)。
 * 失敗はログに残すだけで呼び出し元には伝えない (呼び出し元は既に応答を返し終えているため)。
 * 同一 videoId が {@link prefetchAll} で既にキュー投入済みでも {@link downloadMutex} が
 * 重複ダウンロードを防ぐため、専用の優先度キューは設けていない。
 */
export function triggerBackgroundDownload(
  config: AppConfig,
  videoId: string
): void {
  downloadAndCache(config, videoId).catch((err: unknown) => {
    logger.warn(
      `background download failed for video ${videoId}: ${(err as Error).message}`
    )
  })
}

/**
 * 複数 videoId を並行数を絞りつつ事前ダウンロードする (Playlist Refresh 後のバックグラウンド Prefetch 用)。
 * 1 本の失敗が他の Prefetch を止めないよう、失敗はログに残すだけで例外を投げない。
 */
export async function prefetchAll(
  config: AppConfig,
  videoIds: string[],
  concurrency = 2
): Promise<void> {
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < videoIds.length) {
      const videoId = videoIds[cursor]
      cursor += 1
      try {
        await getOrDownload(config, videoId)
      } catch (err) {
        logger.warn(
          `prefetch failed for video ${videoId}: ${(err as Error).message}`
        )
      }
    }
  }
  const workerCount = Math.min(concurrency, videoIds.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
