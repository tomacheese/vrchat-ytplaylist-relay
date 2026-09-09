import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'
import { clearResolveCache, resolveVideoInfo } from '../src/live-resolve'

let tmpDir: string | undefined

afterEach(() => {
  clearResolveCache()
  if (!tmpDir) return
  fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

/**
 * `yt-dlp -j` の代わりに固定 JSON を stdout に返す偽 yt-dlp スクリプトを作る。
 * 呼び出し回数は `<script>.count` ファイルに記録され、テスト側でキャッシュ挙動を検証できる。
 * `failMessage` を指定すると、常に exit code 1 で失敗する (呼び出し回数は記録される)。
 */
function makeFakeYtdlp(
  dir: string,
  options: { json?: unknown; failMessage?: string }
): { scriptPath: string; countPath: string } {
  const scriptPath = path.join(dir, `fake-ytdlp-${crypto.randomUUID()}.mjs`)
  const countPath = `${scriptPath}.count`
  fs.writeFileSync(countPath, '0')
  // 分岐部分は別途 String.raw で組み立ててから埋め込む。外側の String.raw の `${}` に通常の
  // テンプレートリテラルをネストすると、そちらの `\n` は生成時に実改行へ展開されてしまい
  // (String.raw は外側のリテラルにしか効かない)、生成後の子スクリプトの文字列リテラルが
  // 生の改行を含んで壊れる (SyntaxError) ため、分岐側も String.raw で統一する。
  const body = options.failMessage
    ? String.raw`process.stderr.write(${JSON.stringify(options.failMessage)} + '\n')
process.exit(1)`
    : String.raw`process.stdout.write(${JSON.stringify(JSON.stringify(options.json ?? {}))})`
  fs.writeFileSync(
    scriptPath,
    String.raw`#!/usr/bin/env node
import fs from 'node:fs'
const countPath = ${JSON.stringify(countPath)}
const attempt = Number(fs.readFileSync(countPath, 'utf8')) + 1
fs.writeFileSync(countPath, String(attempt))
${body}
`
  )
  fs.chmodSync(scriptPath, 0o755)
  return { scriptPath, countPath }
}

function readAttemptCount(countPath: string): number {
  return Number(fs.readFileSync(countPath, 'utf8'))
}

test('resolveVideoInfo runs yt-dlp only once for repeated calls within the cache TTL', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-resolve-test-'))
  const { scriptPath, countPath } = makeFakeYtdlp(tmpDir, {
    json: { is_live: false, formats: [] },
  })

  await resolveVideoInfo('v1', {
    ytdlpPath: scriptPath,
    timeoutMs: 5000,
    cacheTtlMs: 60_000,
  })
  await resolveVideoInfo('v1', {
    ytdlpPath: scriptPath,
    timeoutMs: 5000,
    cacheTtlMs: 60_000,
  })

  assert.equal(readAttemptCount(countPath), 1)
})

test('resolveVideoInfo reports isLive: true when yt-dlp reports is_live: true', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-resolve-test-'))
  const { scriptPath } = makeFakeYtdlp(tmpDir, {
    json: { is_live: true, formats: [] },
  })

  const info = await resolveVideoInfo('v1', {
    ytdlpPath: scriptPath,
    timeoutMs: 5000,
    cacheTtlMs: 60_000,
  })

  assert.equal(info.isLive, true)
})

test('resolveVideoInfo reports isLive: false when is_live is absent', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-resolve-test-'))
  const { scriptPath } = makeFakeYtdlp(tmpDir, {
    json: { formats: [] },
  })

  const info = await resolveVideoInfo('v1', {
    ytdlpPath: scriptPath,
    timeoutMs: 5000,
    cacheTtlMs: 60_000,
  })

  assert.equal(info.isLive, false)
})

test('resolveVideoInfo picks the first m3u8_native manifest_url when multiple formats reference it', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-resolve-test-'))
  const { scriptPath } = makeFakeYtdlp(tmpDir, {
    json: {
      is_live: true,
      formats: [
        { protocol: 'https', manifest_url: null },
        {
          protocol: 'm3u8_native',
          manifest_url: 'https://manifest.googlevideo.com/master.m3u8',
        },
        {
          protocol: 'm3u8_native',
          manifest_url: 'https://manifest.googlevideo.com/master.m3u8',
        },
      ],
    },
  })

  const info = await resolveVideoInfo('v1', {
    ytdlpPath: scriptPath,
    timeoutMs: 5000,
    cacheTtlMs: 60_000,
  })

  assert.equal(
    info.hlsMasterManifestUrl,
    'https://manifest.googlevideo.com/master.m3u8'
  )
})

test('resolveVideoInfo returns hlsMasterManifestUrl: null when no m3u8_native format is present', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-resolve-test-'))
  const { scriptPath } = makeFakeYtdlp(tmpDir, {
    json: { is_live: false, formats: [{ protocol: 'https' }] },
  })

  const info = await resolveVideoInfo('v1', {
    ytdlpPath: scriptPath,
    timeoutMs: 5000,
    cacheTtlMs: 60_000,
  })

  assert.equal(info.hlsMasterManifestUrl, null)
})

test('resolveVideoInfo propagates failures and does not cache them (retries yt-dlp on next call)', async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-live-resolve-test-'))
  const { scriptPath, countPath } = makeFakeYtdlp(tmpDir, {
    failMessage: 'ERROR: video unavailable',
  })

  await assert.rejects(
    resolveVideoInfo('v1', {
      ytdlpPath: scriptPath,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
    })
  )
  await assert.rejects(
    resolveVideoInfo('v1', {
      ytdlpPath: scriptPath,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
    })
  )

  assert.equal(readAttemptCount(countPath), 2)
})
