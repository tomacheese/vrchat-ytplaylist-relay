const prefix = '[playlist-server]'

export const logger = {
  info: (message: string, ...rest: unknown[]) => {
    console.log(`${prefix} ${message}`, ...rest)
  },
  warn: (message: string, ...rest: unknown[]) => {
    console.warn(`${prefix} ${message}`, ...rest)
  },
  error: (message: string, ...rest: unknown[]) => {
    console.error(`${prefix} ${message}`, ...rest)
  },
}
