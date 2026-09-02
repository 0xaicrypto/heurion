import { makeLogger } from './logger.js'

/**
 * #801 — 日志检索共享层(admin 端点与 query_logs 工具共用;放 common/
 * 保持 tools/ 不 import modules/* 的分层约束)。
 *
 * 设计要点(AI 是第一消费者):
 *  - 输入是语义化过滤键(container/module/level/sessionId/docId/fileId/tool/q),
 *    不是裸 LogQL — AI 不需要学查询语法;
 *  - 输出是紧凑 JSON 行(截断 500 字符,时间倒序),不是 Loki 原始响应;
 *  - level 过滤同时命中 makeLogger(level:"warn") 与 pino(level:40 数字)。
 */

const log = makeLogger('admin.log-query')

export const LOKI_URL = process.env.LOKI_URL || 'http://loki:3100'

export interface LogQueryFilters {
  container?: string
  module?: string
  level?: string
  sessionId?: string
  docId?: string
  fileId?: string
  tool?: string
  /** 全文子串(行过滤 |= ) */
  q?: string
  /** 时间窗:30m / 2h / 1d 或 ISO 时间;默认 1h */
  since?: string
  limit?: number
}

const PINO_LEVEL: Record<string, number> = { info: 30, warn: 40, error: 50 }

/** '30m'|'2h'|'1d'|ISO → 秒;默认 1h,上限 7d。非法输入走默认。 */
export function resolveWindowSeconds(since?: string): number {
  const MAX = 7 * 24 * 3600
  const DEFAULT = 3600
  if (!since) return DEFAULT
  const rel = since.match(/^(\d+)([mhd])$/)
  if (rel) {
    const mult: Record<string, number> = { m: 60, h: 3600, d: 86400 }
    return Math.min(Number(rel[1]) * mult[rel[2]], MAX)
  }
  const t = Date.parse(since)
  if (Number.isFinite(t)) return Math.min(Math.max((Date.now() - t) / 1000, 60), MAX)
  return DEFAULT
}

function escapeLogql(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** 语义过滤键 → LogQL。JSON 字段过滤走 | json(仅 makeLogger 结构化行有这些键)。 */
export function buildLogQL(f: LogQueryFilters): string {
  let selector = '{job="docker"'
  if (f.container) selector += `, container=~"${escapeLogql(f.container)}"`
  selector += '}'

  const stages: string[] = []
  if (f.q) stages.push(`|= \`${f.q.replace(/[`\\]/g, '')}\``)

  const conds: string[] = []
  if (f.module) conds.push(`module="${escapeLogql(f.module)}"`)
  if (f.level) {
    const pino = PINO_LEVEL[f.level]
    conds.push(pino ? `(level="${f.level}" or level=${pino})` : `level="${escapeLogql(f.level)}"`)
  }
  if (f.sessionId) conds.push(`sessionId="${escapeLogql(f.sessionId)}"`)
  if (f.docId) conds.push(`docId="${escapeLogql(f.docId)}"`)
  if (f.fileId) conds.push(`fileId="${escapeLogql(f.fileId)}"`)
  if (f.tool) conds.push(`tool="${escapeLogql(f.tool)}"`)
  if (conds.length) stages.push('| json', `| ${conds.join(' and ')}`)
  return selector + (stages.length ? ' ' + stages.join(' ') : '')
}

export interface CompactLogLine {
  ts: string
  container: string
  level?: string
  module?: string
  line: string
}

/** Loki query_range 响应 → 紧凑行(时间倒序,单行截断)。 */
export function compactLokiResult(payload: any, maxLine = 500): { lines: CompactLogLine[]; total: number } {
  const lines: CompactLogLine[] = []
  for (const stream of payload?.data?.result ?? []) {
    const container = stream.stream?.container || 'unknown'
    for (const [tsNs, raw] of stream.values ?? []) {
      let level: string | undefined
      let module: string | undefined
      try {
        const j = JSON.parse(raw)
        level = typeof j.level === 'string' ? j.level : undefined
        module = typeof j.module === 'string' ? j.module : undefined
      } catch { /* 非结构化行(caddy/pino 混合) — 保留原文 */ }
      // Loki 时间戳是纳秒,超 Number.MAX_SAFE_INTEGER — 必须 BigInt 换算 ms。
      const tsMs = Number(BigInt(tsNs) / 1000000n)
      lines.push({
        ts: new Date(tsMs).toISOString(),
        container,
        level,
        module,
        line: String(raw).slice(0, maxLine),
      })
    }
  }
  lines.sort((a, b) => (a.ts < b.ts ? 1 : -1))
  return { lines, total: lines.length }
}

export interface LokiQueryResult {
  lines: CompactLogLine[]
  total: number
  error?: string
}

/** 执行查询 — 超时 10s;Loki 不可达时返回 error 而非 throw(排障路径不能被排障工具卡死)。 */
export async function queryLoki(f: LogQueryFilters): Promise<LokiQueryResult> {
  const limit = Math.min(Math.max(f.limit ?? 200, 1), 500)
  const windowSec = resolveWindowSeconds(f.since)
  const endNs = Date.now() * 1e6
  const startNs = endNs - windowSec * 1e9
  const url = `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(buildLogQL(f))}` +
    `&start=${startNs}&end=${endNs}&limit=${limit}&direction=backward`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { lines: [], total: 0, error: `Loki HTTP ${res.status}: ${body.slice(0, 200)}` }
    }
    return compactLokiResult(await res.json(), 500)
  } catch (err) {
    log.warn('loki query failed', { error: (err as Error).message.slice(0, 200), lokiUrl: LOKI_URL })
    return { lines: [], total: 0, error: `Loki unreachable: ${(err as Error).message.slice(0, 200)}` }
  }
}
