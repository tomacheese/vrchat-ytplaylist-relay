import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Manifest, SlotAllocationState, YtdlpFlatEntry } from './types'

/** Thrown when a Playlist's Position Pool (maxSlots) is used up. */
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
 * Writes to a temp file, then renames it. A rename on the same volume is atomic,
 * so readers never see partially written content.
 */
function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * Loads the persisted Position Pool state for a playlistId.
 * @returns null if it has never been refreshed
 */
export function loadSlotState(
  dataDir: string,
  playlistId: string
): SlotAllocationState | null {
  const file = slotStatePath(dataDir, playlistId)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8')) as SlotAllocationState
}

/** Persists the Position Pool state atomically. */
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

/** Computes a stable hash from Track order + videoId + Title (used only to decide whether to bump generation). */
function computeContentHash(entries: YtdlpFlatEntry[]): string {
  const hash = crypto.createHash('sha256')
  for (const entry of entries) {
    // Escape each element with JSON.stringify before joining with newlines,
    // so delimiter characters in videoId / title cannot cause hash collisions.
    hash.update(JSON.stringify([entry.id, entry.title ?? '']))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Pure function: computes the next Position Pool state and the public Manifest from the previous
 * Position Pool state and the latest Playlist contents obtained from yt-dlp.
 *
 * - The videoId -> slot assignment is immutable; an existing videoId keeps its slot
 *   (if it drifted from the baked-in Redirect Pool URLs, playback in the World would break).
 * - Only new videoIds get a new slot (nextSlot++).
 * - If the Position Pool limit would be exceeded, throws SlotPoolExhaustedError; the caller must
 *   keep the previous Position Pool state / cached Manifest as is.
 * - Manifest tracks follow the Playlist order as is; position is the slot number.
 * - generation is bumped only when the Track contents (order + Title) actually change.
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
 * Returns the playlistIds that have been refreshed at least once and have persisted Position Pool
 * state (slots.json). Used by the bulk Refresh (`refreshAll`) to pick targets when the allowlist is
 * disabled (directory names are `encodeURIComponent`-ed in `playlistDir`, so they are restored with
 * `decodeURIComponent`). Returns an empty array if dataDir itself does not exist yet.
 */
export function listKnownPlaylistIds(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return []
  return fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => decodeURIComponent(entry.name))
}

/** Records a Refresh failure in the Position Pool state (slot mappings and generation are left unchanged). */
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
