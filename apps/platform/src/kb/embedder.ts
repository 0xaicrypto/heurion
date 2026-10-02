/**
 * 嵌入服务客户端（apps/embedder：本地 bge-m3）。服务没配 / 没启动 / 还在加载模型时 available() 为 false，
 * 资料库退回关键词检索，等服务就绪后再补向量。
 */
export interface Embedder {
  available(): Promise<boolean>
  embed(texts: string[]): Promise<Float32Array[]>
}

export class HttpEmbedder implements Embedder {
  private checkedAt = 0
  private ok = false

  constructor(private readonly url: string, private readonly timeoutMs = 120_000) {}

  async available(): Promise<boolean> {
    // 健康检查结果缓存 30 秒
    if (Date.now() - this.checkedAt < 30_000) return this.ok
    this.checkedAt = Date.now()
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(3000) })
      this.ok = res.ok
    } catch {
      this.ok = false
    }
    return this.ok
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.url}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) { this.checkedAt = 0; throw new Error(`嵌入服务返回 ${res.status}`) }
    const body = await res.json() as { embeddings: number[][] }
    return body.embeddings.map(v => Float32Array.from(v))
  }
}
