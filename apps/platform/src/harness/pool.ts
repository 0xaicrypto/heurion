import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type HarnessNotification, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { issueToken } from '../auth/token.ts'
import type { Config } from '../config.ts'

export const PROFILE_PATCH = fileURLToPath(new URL('./profile/heurion.cordis.yml', import.meta.url))

interface Entry {
  harness: DeepSeekHarness
  /** 本进程里建立的会话；SDK 不能跨进程恢复会话。 */
  sessionId: string | null
  lastUsed: number
  busy: boolean
}

/**
 * 每个用户一个 dsh 进程（PLATFORM.md §8）：文档不在工作区里，一个会话可以编辑该用户的多份文档。
 * 工作区只放脚本、中间数据与待上传的资产。取消 = 关闭进程（SDK 没有取消方法）。
 */
export class HarnessPool {
  private readonly entries = new Map<string, Entry>()
  private readonly reaper: NodeJS.Timeout

  constructor(private readonly config: Config) {
    this.reaper = setInterval(() => void this.reapIdle(), 60_000)
    this.reaper.unref()
  }

  workspaceDir(userId: string): string {
    const dir = `${this.config.workspacesDir}/${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private childEnv(userId: string): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? this.config.dshHome,
      LANG: process.env.LANG ?? 'C.UTF-8',
      DEEPSEEK_API_KEY: this.config.deepseekApiKey,
      HEURION_MCP_URL: this.config.mcpUrl,
      // MCP 令牌比进程的最长空闲时间长；进程回收后重新签发
      HEURION_MCP_TOKEN: issueToken(this.config.secret, { u: userId, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 24 * 3600 }),
      // 不加载 dsh office 技能：文档编辑只走 MCP
      DSH_PRIMARY_RUNTIME: '',
      PIP_NO_INDEX: '1',
    }
  }

  private entry(userId: string): Entry {
    let e = this.entries.get(userId)
    if (!e) {
      const cwd = this.workspaceDir(userId)
      e = {
        harness: new DeepSeekHarness({
          profile: 'sdk',
          patches: [PROFILE_PATCH],
          dshHome: this.config.dshHome,
          cwd,
          processCwd: cwd,
          env: this.childEnv(userId),
          provider: this.config.provider,
          model: this.config.model,
          initializeTimeoutMs: 60_000,
        }),
        sessionId: null,
        lastUsed: Date.now(),
        busy: false,
      }
      this.entries.set(userId, e)
    }
    return e
  }

  isBusy(userId: string): boolean {
    return this.entries.get(userId)?.busy ?? false
  }

  /** null 表示下一次 run 会开新会话（调用方应补上历史上下文）。 */
  liveSession(userId: string): string | null {
    return this.entries.get(userId)?.sessionId ?? null
  }

  async run(userId: string, prompt: string, onNotification: (n: HarnessNotification, sessionId: string) => void): Promise<RunResult> {
    const e = this.entry(userId)
    if (e.busy) throw new Error('busy')
    e.busy = true
    e.lastUsed = Date.now()
    e.sessionId ??= randomUUID()
    const sessionId = e.sessionId
    try {
      return await e.harness.run(prompt, { sessionId, onNotification: n => onNotification(n, sessionId) })
    } finally {
      e.busy = false
      e.lastUsed = Date.now()
    }
  }

  async cancel(userId: string): Promise<void> {
    const e = this.entries.get(userId)
    if (!e) return
    this.entries.delete(userId)
    await e.harness.close()
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.harnessIdleMs
    for (const [userId, e] of this.entries) {
      if (!e.busy && e.lastUsed < cutoff) await this.cancel(userId).catch(() => {})
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper)
    await Promise.allSettled([...this.entries.keys()].map(id => this.cancel(id)))
  }
}
