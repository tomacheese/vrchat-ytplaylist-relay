import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'
import { downloadVideo, YtdlpError } from '../src/ytdlp'

let tempDir: string | undefined

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function fakeDownloader(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-ytdlp-limit-'))
  const scriptPath = path.join(tempDir, 'fake-ytdlp.mjs')
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const template = args[args.indexOf('-o') + 1]
fs.writeFileSync(template.replace('%(ext)s', 'mp4'), 'new video bytes')
`,
    { mode: 0o755 }
  )
  return scriptPath
}

test('downloadVideo rejects oversized output without replacing a completed file or leaving temporary files', async () => {
  const ytdlpPath = fakeDownloader()
  const dir = path.dirname(ytdlpPath)
  const destPath = path.join(dir, 'cached.mp4')
  fs.writeFileSync(destPath, 'old')
  await assert.rejects(
    downloadVideo('abcdefghijk', destPath, {
      ytdlpPath,
      timeoutMs: 2000,
      maxHeight: 1080,
      maxBytes: 3,
    }),
    (error: unknown) => error instanceof YtdlpError && error.code === 'EFBIG'
  )
  assert.equal(fs.readFileSync(destPath, 'utf8'), 'old')
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes('.download-')),
    false
  )
})

test('downloadVideo accepts a file exactly at the capacity limit', async () => {
  const ytdlpPath = fakeDownloader()
  const destPath = path.join(path.dirname(ytdlpPath), 'cached.mp4')
  await downloadVideo('abcdefghijk', destPath, {
    ytdlpPath,
    timeoutMs: 2000,
    maxHeight: 1080,
    maxBytes: Buffer.byteLength('new video bytes'),
  })
  assert.equal(fs.readFileSync(destPath, 'utf8'), 'new video bytes')
})

test('downloadVideo stops a still-running downloader when temporary output exceeds the capacity limit', async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-ytdlp-monitor-'))
  const dir = tempDir
  const scriptPath = path.join(dir, 'fake-ytdlp.mjs')
  const destPath = path.join(dir, 'cached.mp4')
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const template = args[args.indexOf('-o') + 1]
fs.writeFileSync(template.replace('%(ext)s', 'mp4'), Buffer.alloc(1024 * 1024))
setInterval(() => {}, 1000)
`,
    { mode: 0o755 }
  )
  fs.writeFileSync(destPath, 'old')
  await assert.rejects(
    downloadVideo('abcdefghijk', destPath, {
      ytdlpPath: scriptPath,
      timeoutMs: 10_000,
      maxHeight: 1080,
      maxBytes: 1024,
    }),
    (error: unknown) => error instanceof YtdlpError && error.code === 'EFBIG'
  )
  assert.equal(fs.readFileSync(destPath, 'utf8'), 'old')
  assert.equal(
    fs.readdirSync(dir).some((name) => name.includes('.download-')),
    false
  )
})

test.skipIf(process.platform !== 'linux')(
  'downloadVideo terminates the downloader when temporary output cannot be inspected',
  async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-ytdlp-inspect-'))
    const dir = tempDir
    const scriptPath = path.join(dir, 'fake-ytdlp.mjs')
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const args = process.argv.slice(2)
const template = args[args.indexOf('-o') + 1]
fs.rmSync(path.dirname(template), { recursive: true, force: true })
setInterval(() => {}, 1000)
`,
      { mode: 0o755 }
    )
    await assert.rejects(
      downloadVideo('abcdefghijk', path.join(dir, 'cached.mp4'), {
        ytdlpPath: scriptPath,
        timeoutMs: 10_000,
        maxHeight: 1080,
        maxBytes: 1024,
      }),
      (error: unknown) => error instanceof YtdlpError && error.code === 'EIO'
    )
  }
)

test.skipIf(process.platform !== 'linux')(
  'downloadVideo terminates descendants and waits for pipes to close before timeout cleanup',
  async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-ytdlp-tree-'))
    const dir = tempDir
    const scriptPath = path.join(dir, 'fake-ytdlp.mjs')
    const pidPath = path.join(dir, 'child.pid')
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid))
setInterval(() => {}, 1000)
`,
      { mode: 0o755 }
    )
    try {
      await assert.rejects(
        downloadVideo('abcdefghijk', path.join(dir, 'cached.mp4'), {
          ytdlpPath: scriptPath,
          timeoutMs: 1000,
          maxHeight: 1080,
        }),
        (error: unknown) =>
          error instanceof YtdlpError && error.code === 'ETIMEDOUT'
      )
      assert.ok(
        fs.existsSync(pidPath),
        'fake downloader must spawn a descendant before timeout'
      )
      const pid = Number(fs.readFileSync(pidPath, 'utf8'))
      let state = ''
      try {
        state =
          fs
            .readFileSync(`/proc/${pid}/stat`, 'utf8')
            .split(') ', 2)[1]
            ?.split(' ', 1)[0] ?? ''
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
      }
      assert.ok(
        state === '' || state === 'Z',
        `descendant must not be running (state ${state})`
      )
      assert.equal(
        fs.readdirSync(dir).some((name) => name.includes('.download-')),
        false
      )
    } finally {
      if (fs.existsSync(pidPath)) {
        const pid = Number(fs.readFileSync(pidPath, 'utf8'))
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
        }
      }
    }
  }
)

test.skipIf(process.platform !== 'linux')(
  'downloadVideo terminates descendants and removes temporary files on SIGTERM',
  async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yrp-ytdlp-signal-'))
    const dir = tempDir
    const scriptPath = path.join(dir, 'fake-ytdlp.mjs')
    const pidPath = path.join(dir, 'child.pids')
    const destinationPath = path.join(dir, 'cached.mp4')
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
import fs from 'node:fs'
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' })
fs.appendFileSync(process.env.YR_TEST_PID_PATH, String(child.pid) + String.fromCharCode(10))
setInterval(() => {}, 1000)
`,
      { mode: 0o755 }
    )

    const parent = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `const { downloadVideo } = require('./src/ytdlp.ts'); const destinationPath = process.env.YR_TEST_DESTINATION_PATH; const options = { ytdlpPath: process.env.YR_TEST_SCRIPT_PATH, timeoutMs: 10000, maxHeight: 1080 }; downloadVideo('abcdefghijk', destinationPath, options).catch(() => downloadVideo('abcdefghijk', destinationPath, options).catch(() => {}))`,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          YR_TEST_PID_PATH: pidPath,
          YR_TEST_DESTINATION_PATH: destinationPath,
          YR_TEST_SCRIPT_PATH: scriptPath,
        },
      }
    )

    try {
      const deadline = Date.now() + 5000
      while (!fs.existsSync(pidPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      assert.ok(
        fs.existsSync(pidPath),
        'fake downloader must spawn a descendant'
      )
      const descendantPids = fs
        .readFileSync(pidPath, 'utf8')
        .trim()
        .split('\n')
        .map(Number)
      const parentClosed = new Promise<NodeJS.Signals | null>((resolve) => {
        parent.once('close', (_code, signal) => {
          resolve(signal)
        })
      })
      parent.kill('SIGTERM')
      const exitSignal = await parentClosed
      assert.equal(exitSignal, 'SIGTERM')
      assert.equal(
        descendantPids.length,
        1,
        'shutdown must not spawn another downloader before exiting'
      )

      let state = ''
      try {
        state =
          fs
            .readFileSync(`/proc/${descendantPids[0]}/stat`, 'utf8')
            .split(') ', 2)[1]
            ?.split(' ', 1)[0] ?? ''
      } catch (error) {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
      }
      assert.ok(
        state === '' || state === 'Z',
        `descendant must not be running (state ${state})`
      )
      assert.equal(
        fs.readdirSync(dir).some((name) => name.includes('.download-')),
        false
      )
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGKILL')
      }
      if (fs.existsSync(pidPath)) {
        const pids = fs.readFileSync(pidPath, 'utf8').trim().split('\n')
        for (const pidValue of pids) {
          try {
            process.kill(Number(pidValue), 'SIGKILL')
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH')
          }
        }
      }
    }
  }
)
