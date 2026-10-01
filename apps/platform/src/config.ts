import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录：相对路径配置一律相对它解析。 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

function env(name: string, fallback?: string): string {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`missing required env ${name}`)
}

const dataDir = resolve(repoRoot, env('HEURION_DATA_DIR', './data'))
const port = Number(env('PORT', '8787'))

export const config = {
  port,
  dataDir,
  dbPath: resolve(dataDir, 'platform', 'platform.db'),
  workspacesDir: resolve(dataDir, 'platform', 'workspaces'),
  dshHome: resolve(dataDir, 'platform', 'dsh-home'),
  renderDir: resolve(dataDir, 'platform', 'render'),
  secret: env('HEURION_SECRET', 'dev-secret-not-for-production-use!'),
  /** 开发期：单一 API 令牌 + 单一用户（多用户鉴权在 M2）。 */
  devToken: env('HEURION_DEV_TOKEN', 'dev'),
  devUser: env('HEURION_DEV_USER', 'dev'),
  provider: env('DSH_PROVIDER', 'deepseek-official'),
  model: env('DSH_MODEL', 'deepseek-flash'),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  ncbiApiKey: process.env.NCBI_API_KEY ?? '',
  contactEmail: process.env.CONTACT_EMAIL ?? '',
  /** dsh 进程回连平台 MCP 的地址。 */
  mcpUrl: env('HEURION_MCP_URL', `http://127.0.0.1:${port}/mcp`),
  harnessIdleMs: Number(env('HARNESS_IDLE_MS', String(10 * 60_000))),
  /** 回合无响应超时：模型 / 工具连续这么久没有任何动静，自动停止该回合，放行队列。 */
  turnIdleTimeoutMs: Number(env('TURN_IDLE_TIMEOUT_MS', String(5 * 60_000))),
}

export type Config = typeof config
