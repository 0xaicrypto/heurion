/**
 * §5.5 (#198): structured logger — JSON lines with level/timestamp/module.
 * Zero-dependency; coexists with fastify's request logger (pino). Every
 * degradation path logs here so SLO alerts can key on level=warn/error.
 *
 * #801: 变参兼容 — 既有 (msg, meta) 结构化调用不变;同时接住 console 风格
 * 的多参调用(a, b, obj)——字符串拼接为 msg,最后一个普通对象仍展开为 meta,
 * Error 输出 stack,其他对象 JSON.stringify。裸 console.* 清理(#801 遗留②)
 * 依赖此特性:log.info('[TAG] x', err) 不会静默丢参。
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

function stringifyArg(a: unknown): string {
  if (a instanceof Error) return a.stack || a.message
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a) } catch { return String(a) }
  }
  return String(a)
}

export function makeLogger(module: string) {
  const dispatch = (level: Level, args: unknown[]): void => {
    let meta: Record<string, unknown> = {}
    const parts: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      // 最后一个普通对象(非 Error/数组)视为 meta — 兼容 (msg, meta) 旧签名。
      if (
        i === args.length - 1 && parts.length > 0 &&
        a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Error)
      ) {
        meta = a as Record<string, unknown>
        continue
      }
      parts.push(stringifyArg(a))
    }
    emit(level, parts.join(' '), { module, ...meta })
  }
  return {
    info: (...args: unknown[]) => dispatch('info', args),
    warn: (...args: unknown[]) => dispatch('warn', args),
    error: (...args: unknown[]) => dispatch('error', args),
  }
}
