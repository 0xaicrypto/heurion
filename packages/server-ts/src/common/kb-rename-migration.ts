import prisma from './prisma.js'
import { makeLogger } from './logger.js'

const log = makeLogger('migrate.kb-summary')

/**
 * KB 重命名(article→summary)一次性数据迁移(幂等):
 *  - memory_proposals.kind 列值
 *  - 待审批 approval_requests.payload JSON 内的 kind 字段(前端徽章展示源)
 * 图谱 JSON(memory_graph)与向量索引(embeddings/index.jsonl)不做批量改写,
 * 由各自 load() 读时归一化(memory.graph.ts / embedding-index.ts),下一次
 * 落盘自然收敛为新形态。
 */
export async function ensureArticleSummaryRenameMigration(): Promise<void> {
  try {
    const proposals = await prisma.memoryProposal.updateMany({
      where: { kind: 'article' },
      data: { kind: 'summary' },
    })
    let payloads = 0
    try {
      payloads = await prisma.$executeRawUnsafe(
        `UPDATE approval_requests SET payload = replace(payload, '"kind":"article"', '"kind":"summary"')
         WHERE status = 'pending' AND payload LIKE '%"kind":"article"%'`,
      )
    } catch {
      // payload 列可能不存在于极旧库 — 跳过,前端 toRow 亦有 legacy 归一化兜底
    }
    if (proposals.count > 0 || payloads > 0) {
      log.info(`article→summary rename migration applied: proposals=${proposals.count}, payloads=${payloads}`)
    }
  } catch (err) {
    log.warn('article→summary rename migration skipped:', (err as Error).message.slice(0, 160))
  }
}
