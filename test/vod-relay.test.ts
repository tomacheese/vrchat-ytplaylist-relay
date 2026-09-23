import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'
import type { AppConfig } from '../src/config'

/** JSON ログを object として検証し、field assertion に使える形で返す。 */
function parseLogRecord(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line)
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  return parsed as Record<string, unknown>
}

/** 偽 ffmpeg: 最終引数の出力ファイルへ入力ファイルの内容を連結して書き、正常終了する。 */
const spawnMock = vi.fn((_cmd: string, args: string[]) => {
  const inputs = args.flatMap((a, i) => (args[i - 1] === '-i' ? [a] : []))
  const out = args.at(-1) ?? ''
  fs.writeFileSync(out, Buffer.concat(inputs.map((f) => fs.readFileSync(f))))
  // eslint-disable-next-line unicorn/prefer-event-target
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
  // eslint-disable-next-line unicorn/prefer-event-target
  child.stderr = new EventEmitter()
  setTimeout(() => child.emit('close', 0), 1)
  return child
})
vi.mock('node:child_process', () => ({
  spawn: (...args: [string, string[]]) => spawnMock(...args),
}))

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:URI="https://a.example/audio.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="d",DEFAULT=YES',
  '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028",RESOLUTION=1920x1080,AUDIO="234"',
  'https://v.example/video.m3u8',
  '',
].join('\n')

/** 3 segment の fMP4 相当の media playlist (init 付き)。 */
function mediaPlaylist(prefix: string): string {
  return [
    '#EXTM3U',
    `#EXT-X-MAP:URI="${prefix}-init"`,
    '#EXTINF:5.000,',
    `${prefix}0`,
    '#EXTINF:5.000,',
    `${prefix}1`,
    '#EXTINF:2.500,',
    `${prefix}2`,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n')
}

const bodies: Record<string, string> = {
  'https://f.example/master.m3u8': MASTER,
  'https://v.example/video.m3u8': mediaPlaylist('https://v.example/s'),
  'https://a.example/audio.m3u8': mediaPlaylist('https://a.example/s'),
}

let root: string

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ytdlpTimeoutMs: 1000,
    liveRelayIdleTtlMs: 60_000,
    liveRelayMaxBytes: 10 * 1024 * 1024 * 1024,
    ...overrides,
  } as AppConfig
}

beforeEach(() => {
  spawnMock.mockClear()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-vod-relay-test-'))
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(new Response(bodies[url] ?? `bytes:${url}|`))
    )
  )
})

afterEach(async () => {
  vi.unstubAllGlobals()
  const { stopVodRelay } = await import('../src/vod-relay')
  await stopVodRelay('testVideo01')
  await stopVodRelay('testVideo02')
  fs.rmSync(root, { recursive: true, force: true })
})

test('parseMediaPlaylist reads the init segment, resolves relative URIs and rejects byte ranges', async () => {
  const { parseMediaPlaylist } = await import('../src/vod-relay')
  const parsed = parseMediaPlaylist(
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5.0,\nseg0.ts\n',
    'https://h.example/dir/list.m3u8'
  )
  assert.equal(parsed.init, 'https://h.example/dir/init.mp4')
  assert.deepEqual(parsed.segments, [
    { url: 'https://h.example/dir/seg0.ts', duration: 5 },
  ])
  assert.throws(() =>
    parseMediaPlaylist(
      '#EXTM3U\n#EXTINF:5.0,\n#EXT-X-BYTERANGE:10@0\nseg0.ts\n',
      'https://h.example/x.m3u8'
    )
  )
  assert.throws(() =>
    parseMediaPlaylist('#EXTM3U\n#EXTINF:5.0,\nhttp://h/x.ts\n', 'https://h/')
  )
})

test('ensureVodRelay serves a complete VOD playlist (ENDLIST, source durations) without muxing anything yet', async () => {
  const { ensureVodRelay } = await import('../src/vod-relay')
  const outDir = path.join(root, 'testVideo01')
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const result = await ensureVodRelay(
    makeConfig(),
    'testVideo01',
    outDir,
    'https://f.example/master.m3u8'
  )
  assert.ok('outDir' in result)
  const record = output.mock.calls
    .map(([line]) => parseLogRecord(line as string))
    .find((entry) => entry.event === 'relay.vod.preparation.completed')
  assert.ok(record)
  assert.equal(record.video_id, 'testVideo01')
  assert.ok(record.operation_id)
  assert.equal(record.segment_count, 3)
  assert.ok(typeof record.duration_ms === 'number' && record.duration_ms >= 0)
  output.mockRestore()
  const playlist = fs.readFileSync(path.join(outDir, 'live.m3u8'), 'utf8')
  assert.ok(playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD'))
  assert.ok(playlist.includes('#EXT-X-ENDLIST'))
  assert.ok(playlist.includes('#EXT-X-TARGETDURATION:5'))
  assert.ok(playlist.includes('#EXTINF:2.500,\nseg2.ts'))
  assert.equal(spawnMock.mock.calls.length, 0)
})

test('ensureVodSegment muxes one segment on demand (init prepended), shares concurrent requests and prefetches the next', async () => {
  const { ensureVodRelay, ensureVodSegment } = await import('../src/vod-relay')
  const outDir = path.join(root, 'testVideo01')
  await ensureVodRelay(
    makeConfig(),
    'testVideo01',
    outDir,
    'https://f.example/master.m3u8'
  )

  const [a, b] = await Promise.all([
    ensureVodSegment('testVideo01', 0),
    ensureVodSegment('testVideo01', 0),
  ])
  assert.equal(a, path.join(outDir, 'seg0.ts'))
  assert.equal(a, b)
  assert.equal(
    fs.readFileSync(a, 'utf8'),
    'bytes:https://v.example/s-init|bytes:https://v.example/s0|' +
      'bytes:https://a.example/s-init|bytes:https://a.example/s0|'
  )
  await vi.waitFor(() => {
    assert.equal(spawnMock.mock.calls.length, 2)
  })
  const offsets = spawnMock.mock.calls.map(([, args]) => {
    const i = args.indexOf('-output_ts_offset')
    return args[i + 1]
  })
  assert.deepEqual(offsets, ['0.000', '5.000'])
  assert.ok(!spawnMock.mock.calls[0][1].includes('-copyts'))
  // 先読みの segment 1 も作られる。作業用の一時ファイルは残らない。
  await vi.waitFor(() => {
    assert.ok(fs.existsSync(path.join(outDir, 'seg1.ts')))
  })
  assert.equal(spawnMock.mock.calls.length, 2)
  assert.ok(fs.readdirSync(outDir).every((n) => !/\.(src|tmp)$/.test(n)))

  assert.equal(await ensureVodSegment('testVideo01', 3), null)
  assert.equal(await ensureVodSegment('unknownVid1', 0), null)
})

test('ensureVodRelay returns an error when the video and audio segment counts differ', async () => {
  bodies['https://a.example/audio.m3u8'] =
    '#EXTM3U\n#EXTINF:5.0,\nhttps://a.example/only\n'
  const { ensureVodRelay } = await import('../src/vod-relay')
  const outDir = path.join(root, 'testVideo01')
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const result = await ensureVodRelay(
    makeConfig(),
    'testVideo01',
    outDir,
    'https://f.example/master.m3u8'
  )
  assert.ok('error' in result)
  assert.ok(!fs.existsSync(outDir))
  const record = output.mock.calls
    .map(([line]) => parseLogRecord(line as string))
    .find((entry) => entry.event === 'relay.vod.preparation.failed')
  assert.ok(record)
  assert.equal(record.video_id, 'testVideo01')
  assert.ok(record.operation_id)
  assert.ok(typeof record.duration_ms === 'number' && record.duration_ms >= 0)
  const error = record.error as Record<string, unknown>
  assert.equal(error.type, 'Error')
  assert.equal(error.message, 'video and audio segment counts differ')
  output.mockRestore()
  bodies['https://a.example/audio.m3u8'] = mediaPlaylist('https://a.example/s')
})

test('evictVodRelays drops idle relays and the least recently used one when over the size cap', async () => {
  const { ensureVodRelay, ensureVodSegment, evictVodRelays } =
    await import('../src/vod-relay')
  const dirs = ['testVideo01', 'testVideo02'].map((id) => path.join(root, id))
  await ensureVodRelay(
    makeConfig(),
    'testVideo01',
    dirs[0],
    'https://f.example/master.m3u8'
  )
  await ensureVodSegment('testVideo01', 0)
  await ensureVodRelay(
    makeConfig(),
    'testVideo02',
    dirs[1],
    'https://f.example/master.m3u8'
  )

  await evictVodRelays(makeConfig({ liveRelayMaxBytes: 1 }))
  assert.ok(!fs.existsSync(dirs[0]))
  assert.ok(fs.existsSync(dirs[1]))

  await evictVodRelays(makeConfig({ liveRelayIdleTtlMs: 0 }))
  assert.ok(!fs.existsSync(dirs[1]))
})

test('ensureVodSegment drops the relay when a source segment fetch returns 403 so the next request re-resolves', async () => {
  const { ensureVodRelay, ensureVodSegment, getVodRelay, stopVodRelay } =
    await import('../src/vod-relay')
  const outDir = path.join(root, 'testVideo01')
  await ensureVodRelay(
    makeConfig(),
    'testVideo01',
    outDir,
    'https://f.example/master.m3u8'
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('denied', { status: 403 })))
  )

  await assert.rejects(ensureVodSegment('testVideo01', 0))
  await stopVodRelay('testVideo01')
  assert.equal(getVodRelay('testVideo01'), null)
  assert.ok(!fs.existsSync(outDir))
})
