import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Manifest, SlotAllocationState, YtdlpFlatEntry } from './types'

/** Playlist の Position Pool (maxSlots) が使い切られた際に投げる。 */
export class SlotPoolExhaustedError extends Error {
  constructor(playlistId: string, maxSlots: number) {
    super(
      `Position Pool exhausted for playlist ${playlistId} (maxSlots=${maxSlots})`
    )
    this.name = 'SlotPoolExhaustedError'
  }
}

function playlistDir(dataDir: string, playlistId: string): string {
  return path.join(dataDir, encodeURIComponent(playlistId))
}

function slotStatePath(dataDir: string, playlistId: string): string {
  return path.join(playlistDir(dataDir, playlistId), 'slots.json')
}

/**
 * tmp ファイルへ書いてから rename する。同一ボリューム上の rename は atomic なので、
 * 読み手が書きかけの内容を見ることはない。
 */
function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * playlistId の永続化済み Position Pool 状態を読み込む。
 * @returns まだ一度も Refresh されていない場合は null
 */
export function loadSlotState(
  dataDir: string,
  playlistId: string
): SlotAllocationState | null {
  const file = slotStatePath(dataDir, playlistId)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SlotAllocationState
}

/** Position Pool 状態を atomic に永続化する。 */
export function persistSlotState(
  dataDir: string,
  state: SlotAllocationState
): void {
  writeFileAtomic(
    slotStatePath(dataDir, state.playlistId),
    JSON.stringify(state, null, 2)
  )
}

function emptySlotState(
  playlistId: string,
  maxSlots: number
): SlotAllocationState {
  return {
    playlistId,
    generation: 0,
    nextSlot: 0,
    maxSlots,
    videoIdToSlot: {},
    slotToVideoId: {},
    contentHash: null,
    lastRefreshAt: null,
    lastRefreshOk: false,
    lastError: null,
  }
}

/** Track の順序 + videoId + Title から安定した hash を計算する (generation 更新要否の判定にのみ使う)。 */
function computeContentHash(entries: YtdlpFlatEntry[]): string {
  const hash = crypto.createHash('sha256')
  for (const entry of entries) {
    // videoId / title に区切り文字が含まれても hash が衝突しないよう、要素ごとに
    // JSON.stringify でエスケープしてから改行区切りで連結する。
    hash.update(JSON.stringify([entry.id, entry.title ?? '']))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * 直前の Position Pool 状態と yt-dlp から得た最新の Playlist 内容から、次の Position Pool 状態と
 * 公開用 Manifest を純粋関数として計算する。
 *
 * - videoId -> slot の割当は immutable。既存 videoId の slot は変更しない
 *   (焼き込み済みの Redirect Pool URL と slot 番号の対応がずれると World 側の再生が壊れるため)。
 * - 新規 videoId にのみ新しい slot (nextSlot++) を割り当てる。
 * - Position Pool 上限を超える場合は SlotPoolExhaustedError を投げ、呼び出し側は
 *   直前の Position Pool 状態 / キャッシュ済み Manifest をそのまま維持すること。
 * - Manifest の tracks 順序は Playlist 上の並び順をそのまま使う。position は slot 番号。
 * - generation は Track 内容 (順序 + Title) が実際に変化した場合のみ増分する。
 */
export function buildManifest(
  previous: SlotAllocationState | null,
  playlistId: string,
  maxSlots: number,
  entries: YtdlpFlatEntry[],
  now: number
): { state: SlotAllocationState; manifest: Manifest } {
  const base = previous ?? emptySlotState(playlistId, maxSlots)
  const videoIdToSlot: Record<string, number> = { ...base.videoIdToSlot }
  const slotToVideoId: Record<string, string> = { ...base.slotToVideoId }
  let nextSlot = base.nextSlot

  for (const entry of entries) {
    if (Object.hasOwn(videoIdToSlot, entry.id)) continue
    if (nextSlot >= maxSlots) {
      throw new SlotPoolExhaustedError(playlistId, maxSlots)
    }
    const slot = nextSlot
    nextSlot += 1
    videoIdToSlot[entry.id] = slot
    slotToVideoId[String(slot)] = entry.id
  }

  const contentHash = computeContentHash(entries)
  const generation =
    contentHash === base.contentHash ? base.generation : base.generation + 1

  const state: SlotAllocationState = {
    playlistId,
    generation,
    nextSlot,
    maxSlots,
    videoIdToSlot,
    slotToVideoId,
    contentHash,
    lastRefreshAt: now,
    lastRefreshOk: true,
    lastError: null,
  }

  const manifest: Manifest = {
    playlistId,
    generation,
    updatedAt: now,
    tracks: entries.map((entry) => ({
      position: videoIdToSlot[entry.id],
      title: entry.title ?? '',
    })),
  }

  return { state, manifest }
}

/**
 * これまでに一度でも Refresh され、Position Pool 状態 (slots.json) が永続化済みの
 * playlistId 一覧を返す。allowlist 無効時の一括 Refresh (`refreshAll`) が対象を
 * 決めるのに使う (`playlistDir` で `encodeURIComponent` してディレクトリ名にしているため
 * 復元は `decodeURIComponent` で行う)。dataDir 自体が未作成 (一度も Refresh していない)
 * 場合は空配列を返す。
 */
export function listKnownPlaylistIds(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return []
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => decodeURIComponent(entry.name))
}

/** Refresh 失敗を Position Pool 状態に記録する (slot 対応表・generation は変更しない = 維持する)。 */
export function recordFailure(
  dataDir: string,
  playlistId: string,
  maxSlots: number,
  error: string,
  now: number
): void {
  const previous =
    loadSlotState(dataDir, playlistId) ?? emptySlotState(playlistId, maxSlots)
  const next: SlotAllocationState = {
    ...previous,
    lastRefreshAt: now,
    lastRefreshOk: false,
    lastError: error,
  }
  persistSlotState(dataDir, next)
}
