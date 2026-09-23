import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { logger, normalizeError } from '../src/logger'

afterEach(() => {
  vi.restoreAllMocks()
})

test('logger writes one JSON record with context and sanitized fields', () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined)

  logger.withContext(
    { request_id: 'request-123', operation: 'media.delivery' },
    () => {
      logger.info('media.delivery.completed', 'Delivered media', {
        status_code: 302,
        target:
          'https://user:password@example.test/watch?id=public&sig=private#fragment',
      })
    }
  )

  assert.equal(output.mock.calls.length, 1)
  const record = JSON.parse(output.mock.calls[0][0] as string) as Record<
    string,
    unknown
  > & { target: string }
  assert.equal(record.level, 'info')
  assert.equal(record.event, 'media.delivery.completed')
  assert.equal(record.request_id, 'request-123')
  assert.equal(record.operation, 'media.delivery')
  assert.equal(record.status_code, 302)
  assert.equal(
    record.target,
    'https://example.test/watch?id=%5BREDACTED%5D&sig=%5BREDACTED%5D'
  )
  assert.ok(!record.target.includes('user'))
  assert.ok(!record.target.includes('password'))
  assert.equal(typeof record.timestamp, 'string')
})

test('logger redacts credentials, escapes newlines, and limits stderr', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const stderr = `Bearer very-secret\r\n${'x'.repeat(5000)}`

  logger.error('ytdlp.operation.failed', 'Failed: token=private', {
    authorization: 'Bearer hidden',
    error: { type: 'YtdlpError', message: 'Bearer private', stderr },
  })

  assert.equal(output.mock.calls.length, 1)
  const line = output.mock.calls[0][0] as string
  assert.equal(line.split('\n').length, 1)
  assert.ok(!line.includes('very-secret'))
  assert.ok(!line.includes('private'))
  const record = JSON.parse(line) as {
    message: string
    authorization: string
    error: { message: string; stderr: string }
  }
  assert.equal(record.authorization, '[REDACTED]')
  assert.equal(record.message, 'Failed: token=[REDACTED]')
  assert.equal(record.error.message, 'Bearer [REDACTED]')
  assert.ok(record.error.stderr.length <= 4 * 1024 + '[truncated]'.length + 1)
  assert.ok(record.error.stderr.includes(String.raw`\r\n`))
})

test('logger sanitizes direct Error fields before serialization', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const error = Object.assign(
    new Error(
      'token=message-secret https://example.test/watch?sig=url-secret Bearer bearer-secret'
    ),
    { stderr: `token=stderr-secret\r\n${'x'.repeat(5000)}` }
  )

  logger.error('test.error.redaction', 'Operation failed', {
    error,
    access_token: 'field-access-secret',
    client_secret: 'field-client-secret',
    query_fragment:
      '?token=fragment-secret&access_token=access-secret&client_secret=client-secret',
  })

  assert.equal(output.mock.calls.length, 1)
  const line = output.mock.calls[0][0] as string
  assert.equal(line.split('\n').length, 1)
  assert.ok(!line.includes('message-secret'))
  assert.ok(!line.includes('url-secret'))
  assert.ok(!line.includes('bearer-secret'))
  assert.ok(!line.includes('stderr-secret'))
  assert.ok(!line.includes('fragment-secret'))
  assert.ok(!line.includes('access-secret'))
  assert.ok(!line.includes('client-secret'))
  assert.ok(!line.includes('field-access-secret'))
  assert.ok(!line.includes('field-client-secret'))
  const record = JSON.parse(line) as {
    error: { message: string; stack: string; stderr: string }
  }
  assert.ok(record.error.message.includes('token=[REDACTED]'))
  assert.ok(record.error.message.includes('sig=%5BREDACTED%5D'))
  assert.ok(record.error.stack.includes('token=[REDACTED]'))
  assert.ok(record.error.stderr.length <= 4 * 1024 + '[truncated]'.length + 1)
  assert.ok(record.error.stderr.includes(String.raw`\r\n`))
})

test('normalizeError preserves useful exception context without losing stderr', () => {
  const error = Object.assign(new Error('request failed'), {
    code: 'ETIMEDOUT',
    stderr: 'yt-dlp diagnostic',
  })

  assert.deepEqual(normalizeError(error), {
    type: 'Error',
    message: 'request failed',
    stack: error.stack,
    code: 'ETIMEDOUT',
    stderr: 'yt-dlp diagnostic',
  })
})

test('warn and error use stderr while info uses stdout', () => {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  logger.info('test.info', 'info')
  logger.warn('test.warn', 'warn')
  logger.error('test.error', 'error')

  assert.equal(stdout.mock.calls.length, 1)
  assert.equal(stderr.mock.calls.length, 1)
  assert.equal(errors.mock.calls.length, 1)
})

test('serialization failures produce a minimal fallback event', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic

  logger.info('test.circular', 'Cannot serialize this field', { cyclic })

  const record = JSON.parse(output.mock.calls[0][0] as string) as {
    level: string
    event: string
    message: string
  }
  assert.equal(record.level, 'error')
  assert.equal(record.event, 'logger.serialization.failed')
  assert.equal(record.message, 'Failed to serialize log event')
})
