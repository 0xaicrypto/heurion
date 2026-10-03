import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekHarness, type HarnessNotification, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { issueToken } from '../auth/token.ts'
import type { Config } from '../config.ts'

export const PROFILE_PATCH = fileURLToPath(new URL('./profile/heurion.cordis.yml', import.meta.url))
/** 隔离模式下 SDK 运行的「dsh」：经 sudo 降到用户专属 uid 再启动真正的 dsh。 */
const SANDBOX_LAUNCH = fileURLToPath(new URL('./sandbox-launch.mjs', import.meta.url))

/** 与 SDK 同版本的 dsh 可执行文件（SDK 默认启动的那个；SDK 没有导出解析函数）。 */
function realDshBin(): string {
  const sdk = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client')
  const manifestPath = createRequire(sdk).resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: string | Record<string, string> }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh!
  return resolve(dirname(manifestPath), bin)
}

interface Entry {
  harness: DeepSeekHarness
  /** 本进程里建立的会话；SDK 不能跨进程恢复会话。 */
  sessionId: string | null
  lastUsed: number
  busy: boolean
  /** 进程代号，写进它的 MCP 令牌；进程被停止（entry 删除）后旧令牌立即失效。 */
  generation: string
}

/**
 * 每个用户一个 dsh 进程（PLATFORM.md §8）：文档不在工作区里，一个会话可以编辑该用户的多份文档。
 * 工作区只放脚本、中间数据与待上传的资产。取消 = 关闭进程（SDK 没有取消方法）。
 */
export class HarnessPool {
  private readonly entries = new Map<string, Entry>()
  private readonly reaper: NodeJS.Timeout

  /** sandboxUid：隔离模式下平台用户 → 专属 uid（Store.sandboxUid）。 */
  constructor(private readonly config: Config, private readonly sandboxUid?: (userId: string) => number) {
    this.reaper = setInterval(() => void this.reapIdle(), 60_000)
    this.reaper.unref()
  }

  workspaceDir(userId: string): string {
    const dir = `${this.config.workspacesDir}/${safeName(userId)}`
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 隔离模式：启动器参数（uid、工作区、该用户自己的 dsh home、真正的 dsh）。 */
  private sandboxEnv(userId: string): NodeJS.ProcessEnv {
    if (!this.config.sandbox) return {}
    if (!this.sandboxUid) throw new Error('隔离模式需要 sandboxUid')
    return {
      HEURION_SANDBOX_UID: String(this.sandboxUid(userId)),
      HEURION_SANDBOX_WORKSPACE: this.workspaceDir(userId),
      HEURION_SANDBOX_HOME: `${this.config.dshHomesDir}/${safeName(userId)}`,
      HEURION_DSH_BIN: realDshBin(),
    }
  }

  private childEnv(userId: string, generation: string): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? this.config.dshHome,
      LANG: process.env.LANG ?? 'C.UTF-8',
      // 模型调用经平台代理：这里给的是每用户、绑定进程代号的代理令牌，不是真实 API key
      DEEPSEEK_API_KEY: issueToken(this.config.secret, { u: userId, d: [], p: [], aud: 'llm', ttlSeconds: 24 * 3600, s: generation }),
      DEEPSEEK_BASE_URL: this.config.llmProxyUrl,
      HEURION_MCP_URL: this.config.mcpUrl,
      // MCP 令牌比进程的最长空闲时间长；进程回收后重新签发
      HEURION_MCP_TOKEN: issueToken(this.config.secret, { u: userId, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 24 * 3600, s: generation }),
      // 不加载 dsh office 技能：文档编辑只走 MCP
      DSH_PRIMARY_RUNTIME: '',
      PIP_NO_INDEX: '1',
      ...this.sandboxEnv(userId),
    }
  }

  private entry(userId: string): Entry {
    let e = this.entries.get(userId)
    if (!e) {
      const cwd = this.workspaceDir(userId)
      const generation = randomUUID()
      e = {
        harness: new DeepSeekHarness({
          profile: 'sdk',
          patches: [PROFILE_PATCH],
          // 隔离模式：dsh home 每个用户一份（由启动器以该 uid 建好），SDK 启动的是隔离启动器
          dshHome: this.config.sandbox ? `${this.config.dshHomesDir}/${safeName(userId)}` : this.config.dshHome,
          ...(this.config.sandbox ? { dshBin: SANDBOX_LAUNCH } : {}),
          cwd,
          processCwd: cwd,
          env: this.childEnv(userId, generation),
          provider: this.config.provider,
          model: this.config.model,
          initializeTimeoutMs: 60_000,
        }),
        sessionId: null,
        lastUsed: Date.now(),
        busy: false,
        generation,
      }
      this.entries.set(userId, e)
    }
    return e
  }

  /** 令牌里的进程代号是否仍是该用户当前的 dsh 进程。 */
  isLive(userId: string, generation: string): boolean {
    return this.entries.get(userId)?.generation === generation
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

const safeName = (userId: string) => userId.replace(/[^a-zA-Z0-9_-]/g, '_')
