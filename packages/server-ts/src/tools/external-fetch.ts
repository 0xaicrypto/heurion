/**
 * #835 — 外部文献源统一请求管道。
 *
 * 泛化自 eutilsRequest(#837 治理:节流阀 + 缓存 + 429/5xx 退避),供
 * PubMed/Crossref/Unpaywall/OpenAlex 四个公开免费源共用。设计要点:
 *  - **per-host 独立节流阀**:PubMed 打满不影响 Crossref 通道(写作回合
 *    并行多源检索的前提);
 *  - **两级缓存**(#857/#859/#860,2026-09):L1 进程内存(per-host Map)
 *    → L2 SQLite 持久(url_cache.db,跨部署存活);key 归一化(#858:剔除
 *    api_key/mailto/email 与追踪参数,query 排序);上游最终失败时回退
 *    过期 L2 条目(stale-on-error — 双源全灭事故的对症药);同 key 并发
 *    合并(inflight 去重)。只缓存成功响应,绝不缓存正文;404 等业务分支
 *    不缓存不 stale;
 *  - **polite pool**:Crossref/OpenAlex 走 `?mailto=`、Unpaywall 走 `?email=`,
 *    env 未配置时不注入(匿名池,限速更严但可用);
 *  - **429/5xx 退避重试一次**,尊重 Retry-After;超时不重试(快速失败给
 *    上层降级路径)。
 *  - `URL_CACHE_ENABLED=false` 一键关闭全部缓存行为(绕过 L1/L2/stale 直连)。
 */

import { normalizeCacheKey } from './url-cache/normalize.js'
import { cacheGet as l2Get, cacheSet as l2Set, resetUrlCacheForTest } from './url-cache/store.js'
import { makeLogger } from '../common/logger.js'

export interface ExternalHostConfig {
  baseUrl: string
  /** 错误信息里的源名(如 "PubMed HTTP 429")。 */
  label: string
  /** 同 host 相邻请求的最小间隔(ms)— 全局串行链保证。 */
  minIntervalMs: number
  /** 元数据缓存 TTL(ms) — L1/L2 共用(#860:eutils 5min→6h,持久化后放宽)。 */
  ttlMs: number
  /** 缓存条目上限(LRU 淘汰最旧)。 */
  cacheMax: number
  /** 单请求超时(ms)。 */
  timeoutMs: number
  /** 429/5xx 退避基数(ms),实际取 max(Retry-After, backoffMs)。 */
  backoffMs: number
  /** 鉴权参数(api_key 类):env 存在时自动附到每个请求。 */
  authParam?: { key: string; env: string }
  /** polite pool 参数(mailto/email 类):env 存在时自动附到每个请求。 */
  politeParam?: { key: string; env: string }
  userAgent: string
}

const MIN = 60 * 1000
const HOUR = 60 * MIN

/** 读 env 时求值(测试会在 beforeEach 里设置/删除 env)。 */
function eutilsMinIntervalMs(): number {
  return process.env.NCBI_API_KEY ? 120 : 400
}

/** #860: 缓存总开关 — false 时绕过 L1/L2/stale 全部直连(行为同无缓存)。 */
function urlCacheEnabled(): boolean {
  return process.env.URL_CACHE_ENABLED !== 'false'
}

export const EXTERNAL_HOSTS: Record<string, ExternalHostConfig> = {
  eutils: {
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    label: 'PubMed',
    minIntervalMs: 400, // 占位;externalRequest 按 env 实时取值
    // #860: 5min → 6h — 检索结果/文献记录天级稳定,持久化缓存后放宽;
    // L1 内存短 TTL 语义由同一值承担(命中路径不变)。
    ttlMs: 6 * HOUR,
    cacheMax: 200,
    timeoutMs: 15000,
    backoffMs: 1200,
    authParam: { key: 'api_key', env: 'NCBI_API_KEY' },
    userAgent: 'Heurion/1.0 (medical research agent)',
  },
  crossref: {
    baseUrl: 'https://api.crossref.org',
    label: 'Crossref',
    minIntervalMs: 100,
    ttlMs: 24 * HOUR,
    cacheMax: 200,
    timeoutMs: 15000,
    backoffMs: 1200,
    politeParam: { key: 'mailto', env: 'CROSSREF_MAILTO' },
    userAgent: 'Heurion/1.0',
  },
  openalex: {
    baseUrl: 'https://api.openalex.org',
    label: 'OpenAlex',
    minIntervalMs: 100,
    ttlMs: 24 * HOUR,
    cacheMax: 200,
    timeoutMs: 15000,
    backoffMs: 1200,
    politeParam: { key: 'mailto', env: 'OPENALEX_MAILTO' },
    userAgent: 'Heurion/1.0',
  },
  unpaywall: {
    baseUrl: 'https://api.unpaywall.org',
    label: 'Unpaywall',
    minIntervalMs: 100,
    ttlMs: 24 * HOUR,
    cacheMax: 200,
    timeoutMs: 15000,
    backoffMs: 1200,
    politeParam: { key: 'email', env: 'UNPAYWALL_EMAIL' },
    userAgent: 'Heurion/1.0',
  },
  // #852: DOAJ — OA 状态/APC/许可(期刊选刊动态层)。
  doaj: {
    baseUrl: 'https://doaj.org',
    label: 'DOAJ',
    minIntervalMs: 200,
    ttlMs: 24 * HOUR,
    cacheMax: 200,
    timeoutMs: 15000,
    backoffMs: 1200,
    userAgent: 'Heurion/1.0 (journal selection; DOAJ API polite client)',
  },
}

export interface ExternalRequestOptions { signal?: AbortSignal }

/**
 * #840-r5: 类型化 HTTP 错误(#683 错误通道治理)— 调用方按 status 分支
 * (如 Crossref 404 = DOI 不存在的业务分支),不再解析错误文案。
 */
export class ExternalHttpError extends Error {
  constructor(readonly label: string, readonly status: number, message?: string) {
    super(message ?? `${label} HTTP ${status}`)
    this.name = 'ExternalHttpError'
  }
}

interface HostState {
  chain: Promise<void>
  lastAt: number
  cache: Map<string, { at: number; body: string }>
  /** #860: 同 key 并发合并 — 并行多源检索命中同一 URL 只打一次上游。 */
  inflight: Map<string, Promise<string>>
}

/** per-host 独立状态(节流链 + 缓存 + inflight)。 */
const hostStates = new Map<string, HostState>()

function hostState(name: string): HostState {
  let s = hostStates.get(name)
  if (!s) {
    s = { chain: Promise.resolve(), lastAt: 0, cache: new Map(), inflight: new Map() }
    hostStates.set(name, s)
  }
  return s
}

function cacheGet(state: HostState, key: string, ttlMs: number): string | undefined {
  const hit = state.cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > ttlMs) {
    state.cache.delete(key)
    return undefined
  }
  return hit.body
}

function cacheSet(state: HostState, max: number, key: string, body: string): void {
  state.cache.set(key, { at: Date.now(), body })
  if (state.cache.size > max) {
    // Map 迭代序 = 插入序,淘汰最旧。
    const oldest = state.cache.keys().next().value
    if (oldest !== undefined) state.cache.delete(oldest)
  }
}

/** 测试钩子:重置全部 host 的节流阀与缓存。disk=true(默认)同时清 L2。 */
export function resetExternalFetchState(opts: { disk?: boolean } = {}): void {
  hostStates.clear()
  if (opts.disk !== false) resetUrlCacheForTest()
}

/**
 * 统一外部源 GET:节流 → 两级缓存查询 → fetch(超时+调用方 signal 合并) →
 * 429/5xx 退避重试一次 → 成功响应文本进 L1+L2;上游最终失败时回退过期 L2
 * 条目(stale-on-error,#857 对症"双源全灭")。返回原始文本,解析交给调用方。
 */
export async function externalRequest(
  hostName: keyof typeof EXTERNAL_HOSTS | string,
  path: string,
  params: Record<string, string> = {},
  opts: ExternalRequestOptions = {},
): Promise<string> {
  const cfg = EXTERNAL_HOSTS[hostName]
  if (!cfg) throw new Error(`Unknown external host: ${hostName}`)
  const state = hostState(hostName)

  // #fix 2026-09: 归一化拼接 — 生产事故:baseUrl 无尾斜杠 + 调用方 path 无
  // 头斜杠(eutils 传 'esearch.fcgi')拼成 '/entrez/eutilsesearch.fcgi' →
  // NCBI 永远 404 → 全部落到 Crossref 兜底 → Crossref 429 双源全灭。两侧
  // 斜杠归一后 '/works'(带头斜杠)与 'esearch.fcgi'(不带头斜杠)两种
  // 调用风格都正确。
  const url = new URL(`${cfg.baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  if (cfg.authParam && process.env[cfg.authParam.env]) {
    url.searchParams.set(cfg.authParam.key, String(process.env[cfg.authParam.env]))
  }
  if (cfg.politeParam && process.env[cfg.politeParam.env]) {
    url.searchParams.set(cfg.politeParam.key, String(process.env[cfg.politeParam.env]))
  }
  // #858: 归一化 key — 剔除鉴权/追踪参数+query 排序,env 变更不整批 miss。
  const cacheKey = normalizeCacheKey(url.toString())

  if (urlCacheEnabled()) {
    // L1: 进程内存(per-host Map)
    const l1 = cacheGet(state, cacheKey, cfg.ttlMs)
    if (l1 !== undefined) return l1
    // L2: SQLite 持久 — 新鲜即用(回填 L1);过期记为 stale 降级候选
    let staleFallback: string | undefined
    try {
      const l2 = l2Get(String(hostName), cacheKey)
      if (l2) {
        if (!l2.stale) {
          cacheSet(state, cfg.cacheMax, cacheKey, l2.body)
          return l2.body
        }
        staleFallback = l2.body
      }
    } catch { /* L2 故障降级 — 走直连 */ }

    // #860: inflight 去重 — 同 key 并发只打一次上游,全部等待同一结果。
    const pending = state.inflight.get(cacheKey)
    if (pending) return pending

    const upstream = (async (): Promise<string> => {
      const minIntervalMs = hostName === 'eutils' ? eutilsMinIntervalMs() : cfg.minIntervalMs
      for (let attempt = 0; attempt < 2; attempt++) {
        // per-host 全局节流链 — 串行化并保证最小间隔。
        const gate = state.chain.then(async () => {
          const wait = state.lastAt + minIntervalMs - Date.now()
          if (wait > 0) await new Promise((r) => setTimeout(r, wait))
          state.lastAt = Date.now()
        })
        state.chain = gate.catch(() => {})
        await gate

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
        const signal = opts.signal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([controller.signal, opts.signal])
          : controller.signal
        try {
          const res = await fetch(url.toString(), { signal, headers: { 'User-Agent': cfg.userAgent } })
          if (res.status === 429 || res.status >= 500) {
            const ra = Number(res.headers.get('retry-after')) || 0
            const retryAfterMs = Math.max(ra * 1000, cfg.backoffMs)
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, retryAfterMs))
              continue
            }
            throw new ExternalHttpError(cfg.label, res.status, `${cfg.label} HTTP ${res.status}（已退避重试仍限流）`)
          }
          if (!res.ok) throw new ExternalHttpError(cfg.label, res.status)
          const text = await res.text()
          cacheSet(state, cfg.cacheMax, cacheKey, text)
          l2Set(String(hostName), cacheKey, text, cfg.ttlMs)
          return text
        } finally {
          clearTimeout(timer)
        }
      }
      throw new Error(`${cfg.label} request failed`)
    })()

    state.inflight.set(cacheKey, upstream)
    try {
      return await upstream
    } catch (err) {
      // #857: stale-on-error — 上游最终失败(退避后仍 429/5xx/超时/网络)时,
      // 过期 L2 条目优于整回合检索降级(文献元数据近不可变)。
      if (staleFallback !== undefined) {
        makeLogger('tools.external-fetch').warn(`[external-fetch] stale cache served (${cfg.label})`, { key: cacheKey.slice(0, 120) })
        return staleFallback
      }
      throw err
    } finally {
      state.inflight.delete(cacheKey)
    }
  }

  // URL_CACHE_ENABLED=false — 直连,行为同无缓存(保留节流与退避)。
  const minIntervalMs = hostName === 'eutils' ? eutilsMinIntervalMs() : cfg.minIntervalMs
  for (let attempt = 0; attempt < 2; attempt++) {
    const gate = state.chain.then(async () => {
      const wait = state.lastAt + minIntervalMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      state.lastAt = Date.now()
    })
    state.chain = gate.catch(() => {})
    await gate

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    const signal = opts.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([controller.signal, opts.signal])
      : controller.signal
    try {
      const res = await fetch(url.toString(), { signal, headers: { 'User-Agent': cfg.userAgent } })
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get('retry-after')) || 0
        const retryAfterMs = Math.max(ra * 1000, cfg.backoffMs)
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, retryAfterMs))
          continue
        }
        throw new ExternalHttpError(cfg.label, res.status, `${cfg.label} HTTP ${res.status}（已退避重试仍限流）`)
      }
      if (!res.ok) throw new ExternalHttpError(cfg.label, res.status)
      return await res.text()
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`${cfg.label} request failed`)
}
