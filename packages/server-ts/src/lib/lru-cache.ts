/**
 * #922 重复实现收敛 — 通用 mini-LRU + inflight 合并。
 *
 * 泛化自 document-extractor.ts 的两个手写缓存(extractCache/textExtractCache:
 * Map + 手写"最旧时间戳扫描淘汰"循环),同一实现供多缓存共用。语义与
 * tools/external-fetch.ts 的 L1 缓存一致:
 *  - Map 迭代序 = 插入序,容量满时线性扫描淘汰 `at` 最旧条目(set 已有 key
 *    会刷新 at,但不动 Map 插入位);
 *  - get 带 TTL,过期即删除并返回 undefined;
 *  - load():同 key 并发请求合并到同一 Promise(#860 inflight 模式),成功且
 *    shouldStore 通过才落缓存;失败不缓存、inflight 清理,后续调用重试。
 */

export interface LruEntry<V> {
  value: V
  at: number
}

export class MiniLruCache<V> {
  private map = new Map<string, LruEntry<V>>()
  private inflight = new Map<string, Promise<V>>()

  constructor(
    /** 条目上限(淘汰最旧)。 */
    private max: number,
    /** TTL(ms),get 时惰性过期。 */
    private ttlMs: number,
    /** 可选落库谓词(如"失败/哨兵结果不缓存");缺省全存。 */
    private shouldStore?: (value: V) => boolean,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: V): void {
    if (this.shouldStore && !this.shouldStore(value)) return
    this.map.set(key, { value, at: Date.now() })
    if (this.map.size > this.max) {
      // 线性扫描淘汰 at 最旧(与原手写实现同口径,非 Map 插入序)。
      let oldest: string | null = null
      let oldestAt = Infinity
      for (const [k, v] of this.map) {
        if (v.at < oldestAt) { oldestAt = v.at; oldest = k }
      }
      if (oldest) this.map.delete(oldest)
    }
  }

  /** 命中返回缓存;否则发起 loader 并合并同 key 并发调用。 */
  load(key: string, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key)
    if (cached !== undefined) return Promise.resolve(cached)
    const pending = this.inflight.get(key)
    if (pending) return pending
    const p = loader()
      .then((value) => {
        this.set(key, value)
        return value
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, p)
    return p
  }

  /** 测试钩子:清空缓存与 inflight。 */
  clear(): void {
    this.map.clear()
    this.inflight.clear()
  }
}
