import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

type LogLevel = 'info' | 'warn' | 'error'

/** 非同期処理間で引き継ぐリクエスト・処理の相関情報。 */
interface LogContext {
  request_id?: string
  operation?: string
  operation_id?: string
}

type LogFields = Record<string, unknown>

/** ログへ含める例外の共通形式。 */
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

/** URL の認証情報、query 値、fragment を伏せる。 */
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

/** 秘匿値と制御文字を処理し、必要に応じて診断文字列を制限する。 */
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

/** 例外から型、説明、終了 code、外部診断出力を共通形式へ抽出する。 */
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

/** 任意のログ field を再帰的に秘匿・整形して JSON 化できる値へ変換する。 */
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

/** 共通 field と相関 context を含む JSON Lines record を Console へ出力する。 */
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
  /** 通常の処理 event を stdout へ出力する。 */
  info: (event: string, message: string, fields?: LogFields): void => {
    emit('info', event, message, fields)
  },
  /** 回復可能な問題や fallback event を stderr へ出力する。 */
  warn: (event: string, message: string, fields?: LogFields): void => {
    emit('warn', event, message, fields)
  },
  /** 処理失敗 event を stderr へ出力する。 */
  error: (event: string, message: string, fields?: LogFields): void => {
    emit('error', event, message, fields)
  },
  /** 指定 context を非同期実行へ引き継ぎ、callback の戻り値を返す。 */
  withContext: <T>(context: LogContext, callback: () => T): T => {
    return contextStorage.run(
      { ...contextStorage.getStore(), ...context },
      callback
    )
  },
  /** 現在の非同期実行に紐付く context を取得する。 */
  getContext: (): LogContext => contextStorage.getStore() ?? {},
  /** 新しい operation 相関 ID を発行する。 */
  newOperationId: (): string => randomUUID(),
}
