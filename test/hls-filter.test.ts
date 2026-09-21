import { expect, test } from 'vitest'
import { filterAvc1Master } from '../src/hls-filter'

const BASE = 'https://manifest.googlevideo.com/api/master.m3u8'

const stream = (codecs: string, res: string, audio: string, uri: string) =>
  `#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="${codecs}",RESOLUTION=${res},FRAME-RATE=30,AUDIO="${audio}",CLOSED-CAPTIONS=NONE\n${uri}`

// 実際の YouTube VOD の master manifest の構造 (URL は簡略化)
const master = [
  '#EXTM3U',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-MEDIA:URI="https://a/233",TYPE=AUDIO,GROUP-ID="233",NAME="default",DEFAULT=YES',
  '#EXT-X-MEDIA:URI="https://a/234",TYPE=AUDIO,GROUP-ID="234",NAME="default",DEFAULT=YES',
  stream('avc1.4D401E,mp4a.40.2', '640x360', '234', 'https://v/360'),
  stream('avc1.4D401F,mp4a.40.2', '1280x720', '234', 'https://v/720'),
  stream('avc1.4D400C,mp4a.40.5', '256x144', '233', 'https://v/144'),
  stream('avc1.640028,mp4a.40.2', '1920x1080', '234', 'https://v/1080'),
  stream('vp09.00.21.08,mp4a.40.2', '3840x2160', '234', 'https://v/vp9'),
  '',
].join('\n')

test('keeps only the best AVC1 variant and its audio group', () => {
  const out = filterAvc1Master(master, BASE) ?? ''
  expect(out).toContain('https://v/1080')
  expect(out).not.toMatch(/https:\/\/v\/(360|720|144|vp9)/)
  expect(out).toContain('GROUP-ID="234"')
  expect(out).not.toContain('GROUP-ID="233"')
  expect(out.startsWith('#EXTM3U\n')).toBe(true)
})

test('returns null when no AVC1 variant exists', () => {
  const vp9Only = [
    '#EXTM3U',
    stream('vp09.00.21.08,mp4a.40.2', '640x360', '234', 'https://v/x'),
  ].join('\n')
  expect(filterAvc1Master(vp9Only, BASE)).toBeNull()
})

test('resolves relative URIs against the master URL and drops non-https ones', () => {
  const m = [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="audio/234.m3u8",TYPE=AUDIO,GROUP-ID="234",NAME="d"',
    '#EXT-X-MEDIA:URI="file:///etc/passwd",TYPE=AUDIO,GROUP-ID="234",NAME="x"',
    stream('avc1.640028,mp4a.40.2', '1920x1080', '234', 'file:///etc/hosts'),
    stream('avc1.4D401F,mp4a.40.2', '1280x720', '234', 'video/720.m3u8'),
    '',
  ].join('\n')
  const out = filterAvc1Master(m, BASE) ?? ''
  expect(out).toContain('https://manifest.googlevideo.com/api/video/720.m3u8')
  expect(out).toContain(
    'URI="https://manifest.googlevideo.com/api/audio/234.m3u8"'
  )
  expect(out).not.toContain('file:')
})

test('breaks a height tie by BANDWIDTH', () => {
  const m = [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="https://a/a",TYPE=AUDIO,GROUP-ID="a",NAME="d"',
    '#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="a"',
    'https://v/low',
    '#EXT-X-STREAM-INF:BANDWIDTH=900,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="a"',
    'https://v/high',
    '',
  ].join('\n')
  expect(filterAvc1Master(m, BASE)).toContain('https://v/high')
})

test('does not pick a higher-resolution AVC1 variant that has no playable audio', () => {
  const m = [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="https://a/234",TYPE=AUDIO,GROUP-ID="234",NAME="d"',
    // 1080p: AUDIO も音声コーデックも無い (無音)
    '#EXT-X-STREAM-INF:BANDWIDTH=9,CODECS="avc1.640028",RESOLUTION=1920x1080',
    'https://v/1080-silent',
    stream('avc1.4D401F,mp4a.40.2', '1280x720', '234', 'https://v/720'),
    '',
  ].join('\n')
  const out = filterAvc1Master(m, BASE) ?? ''
  expect(out).toContain('https://v/720')
  expect(out).not.toContain('1080-silent')
})

test('returns null when the referenced audio group has no usable rendition', () => {
  const m = [
    '#EXTM3U',
    '#EXT-X-MEDIA:URI="file:///etc/passwd",TYPE=AUDIO,GROUP-ID="234",NAME="x"',
    stream('avc1.640028,mp4a.40.2', '1920x1080', '234', 'https://v/1080'),
    '',
  ].join('\n')
  expect(filterAvc1Master(m, BASE)).toBeNull()
})

test('accepts a variant without an audio group when its own CODECS include audio', () => {
  const m = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080',
    'https://v/muxed',
    '',
  ].join('\n')
  expect(filterAvc1Master(m, BASE)).toContain('https://v/muxed')
})
