import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录：相对路径配置一律相对它解析，与从哪个目录启动无关。 */
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
  dbPath: resolve(dataDir, 'heurion2.db'),
  workspacesDir: resolve(dataDir, 'workspaces'),
  versionsDir: resolve(dataDir, 'versions'),
  dshHome: resolve(dataDir, 'dsh-home'),
  secret: env('HEURION_SECRET', 'dev-secret-not-for-production-use!'),
  devToken: env('HEURION_DEV_TOKEN', 'dev'),
  provider: env('DSH_PROVIDER', 'deepseek-official'),
  model: env('DSH_MODEL', 'deepseek-v4-flash'),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  primaryRuntime: process.env.DSH_PRIMARY_RUNTIME ?? '',
  ncbiApiKey: process.env.NCBI_API_KEY ?? '',
  contactEmail: process.env.CONTACT_EMAIL ?? '',
  /** dsh 进程回连文献 MCP 的地址（同进程内 /mcp 路由）。 */
  mcpUrl: env('HEURION_MCP_URL', `http://127.0.0.1:${port}/mcp`),
  /** 单个 dsh 进程空闲多久回收（毫秒）。 */
  harnessIdleMs: Number(env('HARNESS_IDLE_MS', String(10 * 60_000))),
  /** Collabora CODE（编辑面，#4 spike）：server 取 discovery 用的地址（容器网络别名）。 */
  collaboraUrl: env('HEURION_COLLABORA_URL', 'http://127.0.0.1:9980'),
  /** 浏览器访问 CODE 的地址（iframe 用；与 server 侧地址在容器拓扑下不同）。 */
  collaboraBrowserUrl: env('HEURION_COLLABORA_BROWSER_URL', 'http://localhost:9980'),
  /** CODE 容器回连本服务的地址（WOPISrc 用；容器网络里指向宿主或服务容器）。 */
  publicUrl: env('HEURION_PUBLIC_URL', `http://127.0.0.1:${port}`),
}

export type Config = typeof config
