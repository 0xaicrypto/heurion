/**
 * dsh SDK 冒烟：用 heurion profile patch 起一个 dsh 进程并完成 initialize 握手。
 * 握手会加载全部插件（验证 patch 有效、日志上传已去掉）；设置了 DEEPSEEK_API_KEY 时再跑一轮真实对话。
 * 需要 server 已在跑（MCP 插件启动时会连 /mcp）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { HarnessPool } from '../src/harness/pool.ts'

const ws = join(config.dataDir, 'smoke-ws')
mkdirSync(ws, { recursive: true })
const pool = new HarnessPool(config, () => ws)
// 用一个真实存在的文档 id，MCP 令牌才能通过校验（否则 dsh 连 /mcp 会被 401）。
const docId = process.argv[2] ?? 'smoke'
const t0 = Date.now()
try {
  await pool.warm(docId)
  console.log(`initialize ok in ${Date.now() - t0}ms`)
  if (config.deepseekApiKey) {
    const r = await pool.run(docId, 'Reply with exactly: pong', () => {})
    console.log(`run ok: ${JSON.stringify(r.finalResponse)} (${r.events.length} events)`)
  } else {
    console.log('DEEPSEEK_API_KEY 未设置，跳过真实对话')
  }
} finally {
  await pool.closeAll()
}
