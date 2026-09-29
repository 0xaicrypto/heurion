/**
 * #1146 — env 正整数解析统一收口（worker job-runner 同款纪律）。
 * 审计实例：`GAP_RESEARCH_INTERVAL_MS=5m` → parseInt → NaN → setInterval(NaN)
 * 近似 1ms 热循环；`abc` → NaN 同理。非法值一律 warn + 回退默认，绝不
 * 静默生效。
 */
export function parseEnvInt(name: string, defaultValue: number, raw?: string): number {
  const value = raw ?? process.env[name]
  if (value === undefined || value.trim() === '') return defaultValue
  // 必须整串为整数 — parseInt('5m')=5 会把审计实例(5m→5ms 热循环)放行。
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    console.warn(`[env] ${name}=${JSON.stringify(value)} is not a positive integer — falling back to ${defaultValue}`)
    return defaultValue
  }
  return n
}
