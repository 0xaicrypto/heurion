import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type HarnessNotification, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import type { Config } from '../config.ts'
import { signDocToken } from '../literature/token.ts'

export const PROFILE_PATCH = fileURLToPath(new URL('./profile/heurion.cordis.yml', import.meta.url))

interface Entry {
  harness: DeepSeekHarness
  /** 本进程里建立的会话。SDK 无 resume：进程重启后旧会话不可续，须开新会话。 */
  sessionId: string | null
  lastUsed: number
  busy: boolean
}

/**
 * 每个文档一个 dsh 进程（SDK 的工作区是进程级的，initialize 时固定 cwd）。
 * SDK 协议没有取消方法：取消 = 关闭该文档的进程，下次请求按 sessionId 续上会话。
 */
export class HarnessPool {
  private readonly entries = new Map<string, Entry>()
  private readonly reaper: NodeJS.Timeout

  constructor(private readonly config: Config, private readonly workspaceDir: (docId: string) => string) {
    this.reaper = setInterval(() => void this.reapIdle(), 60_000)
    this.reaper.unref()
  }

  /** 子进程环境：显式白名单，不继承父进程的任何其他密钥。 */
  private childEnv(docId: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? this.config.dshHome,
      LANG: process.env.LANG ?? 'C.UTF-8',
      DEEPSEEK_API_KEY: this.config.deepseekApiKey,
      HEURION_MCP_URL: this.config.mcpUrl,
      HEURION_MCP_TOKEN: signDocToken(this.config.secret, docId),
      // 空串 = 显式关闭 office 运行时查询与 office 技能（见 sdk-app profile）。
      DSH_PRIMARY_RUNTIME: this.config.primaryRuntime,
      // office Python 库已随运行环境预装；不让模型从网络装包
      PIP_NO_INDEX: '1',
    }
    return env
  }

  private entry(docId: string): Entry {
    let e = this.entries.get(docId)
    if (!e) {
      e = {
        harness: new DeepSeekHarness({
          profile: 'sdk',
          patches: [PROFILE_PATCH],
          dshHome: this.config.dshHome,
          cwd: this.workspaceDir(docId),
          processCwd: this.workspaceDir(docId),
          env: this.childEnv(docId),
          provider: this.config.provider,
          model: this.config.model,
          initializeTimeoutMs: 60_000,
        }),
        sessionId: null,
        lastUsed: Date.now(),
        busy: false,
      }
      this.entries.set(docId, e)
    }
    return e
  }

  isBusy(docId: string): boolean {
    return this.entries.get(docId)?.busy ?? false
  }

  /** 启动并完成握手（用于冒烟与预热）。 */
  async warm(docId: string): Promise<void> {
    await this.entry(docId).harness.start()
  }

  /** 该文档在当前进程里的会话；null 表示下一次 run 会开新会话（调用方应补上历史上下文）。 */
  liveSession(docId: string): string | null {
    return this.entries.get(docId)?.sessionId ?? null
  }

  async run(
    docId: string,
    prompt: string,
    onNotification: (n: HarnessNotification, sessionId: string) => void,
  ): Promise<RunResult> {
    const e = this.entry(docId)
    if (e.busy) throw new Error('document is busy')
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

  /** 取消正在进行的回合：关闭进程（SDK 无 prompt-cancel）。 */
  async cancel(docId: string): Promise<void> {
    const e = this.entries.get(docId)
    if (!e) return
    this.entries.delete(docId)
    await e.harness.close()
  }

  private async reapIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.harnessIdleMs
    for (const [docId, e] of this.entries) {
      if (!e.busy && e.lastUsed < cutoff) await this.cancel(docId).catch(() => {})
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.reaper)
    await Promise.allSettled([...this.entries.keys()].map(id => this.cancel(id)))
  }
}
