import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

type LogLevel = 'info' | 'warn' | 'error'

/** Request/operation correlation info carried across async work. */
interface LogContext {
  request_id?: string
  operation?: string
  operation_id?: string
}

type LogFields = Record<string, unknown>

/** Common shape of an error included in logs. */
interface ErrorRecord {
  type: string
  message: string
  stack?: string
  code?: string | number
  stderr?: string
}

const contextStorage = new AsyncLocalStorage<LogContext>()
const sensitiveKeyPattern =
  /^(?:authorization|cookie|password|secret|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|api[_-]?key|signature|sig|auth|key)$/i
const sensitiveAssignmentPattern =
  /\b((?:[a-z0-9]+[_-])*(?:authorization|cookie|api[_-]?key|token|signature|sig|auth|key|password|secret))\s*([=:])\s*([^\s&,;#]+)/gi
const bearerPattern = /\bBearer\s+[^\s,;]+/gi
const urlPattern = /https?:\/\/[^\s"'<>]+/gi
const maxDiagnosticLength = 4 * 1024

/** Masks URL credentials, query values and fragment. */
function redactUrl(value: string): string {
  let suffix = ''
  let candidate = value
  while (/[),.;!?\]}]$/.test(candidate)) {
    suffix = candidate.slice(-1) + suffix
    candidate = candidate.slice(0, -1)
  }

  try {
    const url = new URL(candidate)
    url.username = ''
    url.password = ''
    if (url.search) {
      for (const key of url.searchParams.keys()) {
        url.searchParams.set(key, '[REDACTED]')
      }
    }
    url.hash = ''
    return `${url.href}${suffix}`
  } catch {
    return '[REDACTED_URL]'
  }
}

/** Masks secrets and control characters, and truncates diagnostic strings when needed. */
function sanitizeString(value: string, limit?: number): string {
  let sanitized = value
    .replaceAll(
      sensitiveAssignmentPattern,
      (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`
    )
    .replaceAll(urlPattern, (url) => redactUrl(url))
    .replaceAll(bearerPattern, 'Bearer [REDACTED]')
    .split('')
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      if (character === '\n') return String.raw`\n`
      if (character === '\r') return String.raw`\r`
      if (character === '\t') return String.raw`\t`
      if (codePoint === 127 || codePoint < 32) {
        return `${String.raw`\u`}${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
      }
      return character
    })
    .join('')

  if (limit !== undefined && sanitized.length > limit) {
    sanitized = `${sanitized.slice(0, limit)}…[truncated]`
  }
  return sanitized
}

/** Extracts the type, message, exit code and external diagnostic output from an error into the common shape. */
export function normalizeError(value: unknown): ErrorRecord {
  const error = value instanceof Error ? value : new Error(String(value))
  const errorWithDetails = error as Error & {
    code?: unknown
    stderr?: unknown
  }
  const record: ErrorRecord = {
    type: error.name || error.constructor.name,
    message: error.message,
  }
  if (error.stack) record.stack = error.stack
  if (
    typeof errorWithDetails.code === 'string' ||
    typeof errorWithDetails.code === 'number'
  ) {
    record.code = errorWithDetails.code
  }
  if (typeof errorWithDetails.stderr === 'string') {
    record.stderr = errorWithDetails.stderr
  }
  return record
}

/** Recursively masks and normalizes any log field into a JSON-serializable value. */
function sanitizeValue(value: unknown, key = ''): unknown {
  if (sensitiveKeyPattern.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    const limit = ['message', 'stack', 'stderr'].includes(key)
      ? maxDiagnosticLength
      : undefined
    return sanitizeString(value, limit)
  }
  if (value instanceof Error) {
    return Object.fromEntries(
      Object.entries(normalizeError(value)).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ])
    )
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey),
      ])
    )
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  return value
}

/** Writes a JSON Lines record with common fields and correlation context to the console. */
function emit(
  level: LogLevel,
  event: string,
  message: string,
  fields: LogFields = {}
): void {
  const context = contextStorage.getStore() ?? {}
  let line: string
  try {
    const safeFields = sanitizeValue(fields) as LogFields
    const record: Record<string, unknown> = {
      ...context,
      ...safeFields,
      ...(context.request_id && { request_id: context.request_id }),
      timestamp: new Date().toISOString(),
      level,
      event,
      message: sanitizeString(message, maxDiagnosticLength),
    }
    line = JSON.stringify(record)
  } catch {
    line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'logger.serialization.failed',
      message: 'Failed to serialize log event',
    })
    level = 'error'
  }

  if (level === 'info') console.log(line)
  else if (level === 'warn') console.warn(line)
  else console.error(line)
}

export const logger = {
  /** Writes a normal processing event to stdout. */
  info: (event: string, message: string, fields?: LogFields): void => {
    emit('info', event, message, fields)
  },
  /** Writes a recoverable problem or fallback event to stderr. */
  warn: (event: string, message: string, fields?: LogFields): void => {
    emit('warn', event, message, fields)
  },
  /** Writes a processing failure event to stderr. */
  error: (event: string, message: string, fields?: LogFields): void => {
    emit('error', event, message, fields)
  },
  /** Runs the callback with the given context carried across async execution, returning its result. */
  withContext: <T>(context: LogContext, callback: () => T): T => {
    return contextStorage.run(
      { ...contextStorage.getStore(), ...context },
      callback
    )
  },
  /** Returns the context bound to the current async execution. */
  getContext: (): LogContext => contextStorage.getStore() ?? {},
  /** Issues a new operation correlation ID. */
  newOperationId: (): string => randomUUID(),
}
