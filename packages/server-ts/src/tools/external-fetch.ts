/**
 * #835 — 外部文献源统一请求管道。
 *
 * 泛化自 eutilsRequest(#837 治理:节流阀 + 缓存 + 429/5xx 退避),供
 * PubMed/Crossref/Unpaywall/OpenAlex 四个公开免费源共用。设计要点:
 *  - **per-host 独立节流阀**:PubMed 打满不影响 Crossref 通道(写作回合
 *    并行多源检索的前提);
 *  - **per-host 缓存**:元数据缓存 TTL 收口 D22 `external_kb_cache_ttl_hours=24`
 *    (eutils 保持 5min 既有语义,调用面不变);只缓存元数据,绝不缓存正文;
 *  - **polite pool**:Crossref/OpenAlex 走 `?mailto=`、Unpaywall 走 `?email=`,
 *    env 未配置时不注入(匿名池,限速更严但可用);
 *  - **429/5xx 退避重试一次**,尊重 Retry-After;超时不重试(快速失败给
 *    上层降级路径)。
 */

export interface ExternalHostConfig {
  baseUrl: string
  /** 错误信息里的源名(如 "PubMed HTTP 429")。 */
  label: string
  /** 同 host 相邻请求的最小间隔(ms)— 全局串行链保证。 */
  minIntervalMs: number
  /** 元数据缓存 TTL(ms)。 */
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

export const EXTERNAL_HOSTS: Record<string, ExternalHostConfig> = {
  eutils: {
    baseUrl: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils',
    label: 'PubMed',
    minIntervalMs: 400, // 占位;externalRequest 按 env 实时取值
    ttlMs: 5 * MIN,
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
}

/** per-host 独立状态(节流链 + 缓存)。 */
const hostStates = new Map<string, HostState>()

function hostState(name: string): HostState {
  let s = hostStates.get(name)
  if (!s) {
    s = { chain: Promise.resolve(), lastAt: 0, cache: new Map() }
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

/** 测试钩子:重置全部 host 的节流阀与缓存。 */
export function resetExternalFetchState(): void {
  hostStates.clear()
}

/**
 * 统一外部源 GET:节流 → 缓存查询 → fetch(超时+调用方 signal 合并) →
 * 429/5xx 退避重试一次 → 成功响应文本进缓存。返回原始文本,解析交给调用方。
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
  const cacheKey = url.toString()

  const cached = cacheGet(state, cacheKey, cfg.ttlMs)
  if (cached !== undefined) return cached

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
      return text
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`${cfg.label} request failed`)
}
