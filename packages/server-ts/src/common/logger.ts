/**
 * §5.5 (#198): structured logger — JSON lines with level/timestamp/module.
 * Zero-dependency; coexists with fastify's request logger (pino). Every
 * degradation path logs here so SLO alerts can key on level=warn/error.
 */
type Level = 'info' | 'warn' | 'error'

export interface LogMeta {
  module: string
  requestId?: string
  [key: string]: unknown
}

function emit(level: Level, msg: string, meta: LogMeta): void {
  const line = JSON.stringify({
    level,
    ts: new Date().toISOString(),
    msg,
    ...meta,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

export function makeLogger(module: string) {
  return {
    info: (msg: string, meta: Record<string, unknown> = {}) => emit('info', msg, { module, ...meta }),
    warn: (msg: string, meta: Record<string, unknown> = {}) => emit('warn', msg, { module, ...meta }),
    error: (msg: string, meta: Record<string, unknown> = {}) => emit('error', msg, { module, ...meta }),
  }
}
