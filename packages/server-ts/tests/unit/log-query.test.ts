import { describe, test, expect } from 'vitest'
import { resolveWindowSeconds, buildLogQL, compactLokiResult } from '../../src/common/log-query.js'

describe('resolveWindowSeconds', () => {
  test('相对时间', () => {
    expect(resolveWindowSeconds('30m')).toBe(1800)
    expect(resolveWindowSeconds('2h')).toBe(7200)
    expect(resolveWindowSeconds('1d')).toBe(86400)
  })
  test('默认 1h,非法输入走默认', () => {
    expect(resolveWindowSeconds(undefined)).toBe(3600)
    expect(resolveWindowSeconds('nonsense')).toBe(3600)
  })
  test('ISO 时间 → 距今秒数(夹在 60s 与 7d 之间)', () => {
    const iso = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    expect(resolveWindowSeconds(iso)).toBeGreaterThanOrEqual(300)
    expect(resolveWindowSeconds(iso)).toBeLessThan(320)
    expect(resolveWindowSeconds(new Date(Date.now() - 365 * 86400 * 1000).toISOString())).toBe(7 * 24 * 3600)
  })
  test('上限 7d', () => {
    expect(resolveWindowSeconds('999d')).toBe(7 * 24 * 3600)
  })
})

describe('buildLogQL', () => {
  test('无过滤 — 全容器 selector', () => {
    expect(buildLogQL({})).toBe('{job="docker"}')
  })
  test('container 正则匹配', () => {
    expect(buildLogQL({ container: 'nexus-server|nexus-caddy' })).toBe('{job="docker", container=~"nexus-server|nexus-caddy"}')
  })
  test('q 全文过滤', () => {
    expect(buildLogQL({ q: 'timed out' })).toBe('{job="docker"} |= `timed out`')
  })
  test('JSON 字段过滤走 | json;level 双口径(makeLogger 字符串 + pino 数字)', () => {
    expect(buildLogQL({ module: 'files.download' })).toBe('{job="docker"} | json | module="files.download"')
    expect(buildLogQL({ level: 'warn' })).toBe('{job="docker"} | json | (level="warn" or level=40)')
    expect(buildLogQL({ level: 'error' })).toBe('{job="docker"} | json | (level="error" or level=50)')
  })
  test('多条件组合 + 双引号转义', () => {
    const ql = buildLogQL({ container: 'nexus-server', module: 'files.download', level: 'error', docId: 'doc_1', q: 'x' })
    expect(ql).toBe('{job="docker", container=~"nexus-server"} |= `x` | json | module="files.download" and (level="error" or level=50) and docId="doc_1"')
  })
})

describe('compactLokiResult', () => {
  const payload = {
    status: 'success',
    data: {
      result: [
        {
          stream: { container: 'nexus-server' },
          values: [
            [(1788357418959000000).toString(), JSON.stringify({ level: 'info', ts: 'x', module: 'files.download', msg: 'download ok', fileId: 'f1' })],
            [(1788357418958000000).toString(), '[GAP-RESEARCH] processed 5 errors 0'],
          ],
        },
      ],
    },
  }

  test('解析为紧凑行,时间倒序,提取 level/module', () => {
    const { lines, total } = compactLokiResult(payload)
    expect(total).toBe(2)
    expect(lines[0].ts > lines[1].ts).toBe(true)
    expect(lines[0].module).toBe('files.download')
    expect(lines[0].level).toBe('info')
    expect(lines[1].module).toBeUndefined()
    expect(lines[0].container).toBe('nexus-server')
  })

  test('单行截断到 500 字符', () => {
    const long = { data: { result: [{ stream: { container: 'c' }, values: [[(1e18).toString(), 'x'.repeat(900)]] }] } }
    expect(compactLokiResult(long).lines[0].line.length).toBe(500)
  })

  test('空响应', () => {
    expect(compactLokiResult({ data: { result: [] } })).toEqual({ lines: [], total: 0 })
  })
})
