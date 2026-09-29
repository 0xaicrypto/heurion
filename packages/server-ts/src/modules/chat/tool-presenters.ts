/**
 * #789③ — per-tool 工具结果 SSE 投影注册表（从 tool-loop.ts 拆出，P2 大文件
 * 棘轮）。presenters 是纯 SSE 投影（无 registry/prisma 访问）：工具输出由
 * 主循环统一 parse 一次，按 matches 分发；#1134 起客户端出口的正文在此重签
 * 文件 URL token（库内为无 token 规范形态，#1128）。
 */
import { makeLogger } from '../../common/logger.js'
import { refreshFileUrls } from '../../common/chart-token.js'
import type { ChatStreamChunk, DeckWire, TaskPlan } from '@heurion/contracts'
import { deckWireSchema, blockProjectionSchema, sectionMetaMapSchema } from '@heurion/contracts'

const log = makeLogger('chat.tool-presenters')

export interface TurnIO {
  send: (chunk: ChatStreamChunk) => void
  signal: AbortSignal
}

/**
 * #789③ — per-tool result presenters, replacing the if-chain that grew a
 * new branch per media tool (open/closed violation) and re-`JSON.parse`d the
 * same output up to 3×/round with independent silent catches. The loop now
 * parses the tool output ONCE and hands the object to every matching
 * presenter; presenters are pure SSE-projection (no registry/prisma access).
 */
export interface PresentEnv {
  io: TurnIO
  toolName: string
  /** #1134: 客户端出口重签文件 URL token 需用户上下文 — 库内正文为无 token 形态。 */
  userId: string
  /** #927: doc_updated 版本标识 — rev 单调递增,updatedAt 为服务端写回时间(ISO)。 */
  docRev?: number
  docUpdatedAt?: string
}

interface ToolResultPresenter {
  matches: (toolName: string) => boolean
  present: (parsed: Record<string, unknown>, env: PresentEnv) => void
}

/** Tools whose output carries a full document body for the writing canvas.
 *  P0 hotfix 2026-09: 导出 — doc-executor 兜底只用这份写回工具面组装
 *  精简重试回路,复用同一集合避免两处手写。 */
// #1101/#1112: edit_deck_bytes — deck pptx 工件编辑走同一 doc_updated 管道
// （卡片流 edit_deck 已退役）。
export const DOC_WRITE_TOOLS = new Set(['edit_document', 'insert_asset', 'edit_deck_bytes', 'fix_document_images'])

// #927: doc_updated rev — SSE 消费方(writing-editor)据此幂等防乱序(rev
// 不大于已应用值的写回直接忽略)。
// #1085: rev 必须跨进程重启保持单调 — 旧实现是纯内存小整数计数器（进程
// 内单调），服务端重启（生产发版 / 崩溃 / dev 的 tsx watch 热重启）后从 0
// 重新计数，而已打开标签页的 appliedDocRevRef 仍停在重启前高位，重启后的
// 全部写回被幂等守卫误判为乱序并静默丢弃（必须手动刷新页面才能恢复）。
// 修法：时间基单调 — 取 `max(计数器+1, 当前毫秒)`。同一进程内仍严格递增
// （+1 兜底同毫秒并发写）；跨重启新进程首笔 rev 即当前毫秒，必然大于旧
// 进程的历史小整数计数器，客户端守卫语义（#927 严格大于）零改动自然恢复。
// 无需 schema 迁移；时钟大幅回拨（NTP 异常）是唯一理论边界——比旧实现
// 的"每次重启必坏"严格更优。
let docWriteRev = 0

/** #1085: rev 生成器（导出仅供测试 — 单调性/重启归零恢复的行为锚定）。 */
export function nextDocWriteRev(): number {
  docWriteRev = Math.max(docWriteRev + 1, Date.now())
  return docWriteRev
}

export const PRESENTERS: ToolResultPresenter[] = [
  // #976: set_task_plan 输出 → plan_updated SSE（source: model）。
  {
    matches: (toolName) => toolName === 'set_task_plan',
    present: (parsed, env) => {
      const plan = parsed?.plan as TaskPlan | undefined
      if (!plan) return
      env.io.send({
        type: 'plan_updated',
        plan: plan as never,
        kind: (String(parsed?.kind || 'advanced') as never),
        source: 'model',
        progress: { done: plan.steps.filter((s: { status?: string }) => s.status === 'done').length, total: plan.steps.length },
      })
    },
  },
  {
    // #419: generated images render in the chat stream.
    matches: (t) => t === 'generate_image',
    present: (parsed, { io }) => {
      if (typeof parsed.url === 'string' && parsed.url) {
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : ''
        io.send({ type: 'image_attached', url: parsed.url, caption: prompt.slice(0, 120) })
      }
    },
  },
  {
    // #418: surface memory-search hits to the doctor (AI 依据可见).
    matches: (t) => t === 'search_node',
    present: (parsed, { io }) => {
      const hits = Array.isArray(parsed.hits) ? parsed.hits : []
      if (hits.length > 0) {
        io.send({
          type: 'memory_hits',
          count: hits.length,
          hits: hits.slice(0, 10).map((h: Record<string, unknown>) => ({
            content: String(h.content || '').slice(0, 200),
            type: String(h.node_type || 'fact'),
            id: String(h.node_id || ''),
          })),
        })
      }
    },
  },
  {
    // §15.4/#765/#773: document write-backs to the writing canvas —
    // doc_updated (body+deck 同帧) plus insert_asset's sidecar_file
    // (export 产物下载卡片 + knowledge_payload 进知识索引).
    matches: (t) => DOC_WRITE_TOOLS.has(t),
    present: (parsed, { io, toolName, userId, docRev, docUpdatedAt }) => {
      if (typeof parsed.body === 'string') {
        // #790: deck 产出端过 deckWireSchema — 形状损坏降级 null
        // (前端 as DeckWire 强转兜不住坏数据)。
        let deck: DeckWire | null = null
        if (parsed.deck !== undefined && parsed.deck !== null) {
          const check = deckWireSchema.safeParse(parsed.deck)
          deck = check.success ? check.data : null
          if (!check.success) log.warn('doc_updated.deck failed schema check — degraded to null')
        }
        io.send({
          type: 'doc_updated',
          // #1134: 库内正文为无 token 规范形态(写库时剥离,#1128)— 推送前端
          // 前重签,否则 AI 写回后图片/下载链接 401。工具输出给 LLM 看的形态
          // 不动,仅客户端出口签发。
          body: refreshFileUrls(parsed.body, userId),
          summary: typeof parsed.summary === 'string' ? parsed.summary : '',
          // #408-followup: 标题写回(可单独或与正文同帧)— 前端同步页头/输入框。
          ...(typeof parsed.title === 'string' && parsed.title ? { title: parsed.title } : {}),
          ...(parsed.deck !== undefined ? { deck } : {}),
          // #927: 版本标识 — 前端按 rev 幂等防乱序(rev ≤ 已应用值忽略)。
          ...(docRev !== undefined ? { rev: docRev, updatedAt: docUpdatedAt } : {}),
          // #989 Phase 3: 块级结构投影(写回单点同帧派生)— 产出端过 schema,
          // 损坏降级不携带(前端按无投影处理)。
          ...(parsed.projection !== undefined && parsed.projection !== null
            ? (() => {
                const check = blockProjectionSchema.safeParse(parsed.projection)
                if (!check.success) { log.warn('doc_updated.projection failed schema check — degraded to absent'); return {} }
                return { projection: check.data }
              })()
            : {}),
          // #996/#999: 节级作者/可信度标签 — 工具输出透传,损坏降级不携带。
          ...(parsed.sectionMeta !== undefined && parsed.sectionMeta !== null
            ? (() => {
                const check = sectionMetaMapSchema.safeParse(parsed.sectionMeta)
                if (!check.success) { log.warn('doc_updated.section_meta failed schema check — degraded to absent'); return {} }
                return { section_meta: check.data }
              })()
            : {}),
          // #996/#1003: 本轮实际变更节(写回单点派生)— 聊天改动日志持久化
          // 数据源;覆盖 range-edit/full_text/insert_asset 等全路径。形状
          // 简单的内联校验,损坏/空降级不携带。
          ...(() => {
            const raw = parsed.changedSections
            if (!Array.isArray(raw)) return {}
            const sections = raw
              .filter((s): s is Record<string, unknown> => Boolean(s) && typeof (s as Record<string, unknown>).id === 'string' && Boolean((s as Record<string, unknown>).id))
              .slice(0, 50)
              .map((s) => ({ id: String(s.id), heading: typeof s.heading === 'string' ? s.heading.slice(0, 300) : '' }))
            return sections.length > 0 ? { changed_sections: sections } : {}
          })(),
          // #1113: deck 工件版本随写回下发 — 已打开画布据此实时刷新
          // （edit_deck_bytes 输出 version；字节走 GET 不占 SSE）。
          ...(typeof parsed.version === 'string' && parsed.version ? { deck_version: parsed.version } : {}),
        })
      }
      if (toolName === 'insert_asset') {
        const file = parsed.file as Record<string, unknown> | undefined
        const knowledge = parsed.knowledge as { title?: string; content?: string } | undefined
        if (file && typeof file.fileId === 'string' && typeof file.url === 'string' && file.fileId && file.url) {
          const fileName = (typeof file.fileName === 'string' && file.fileName) || file.fileId
          const body = typeof parsed.body === 'string' ? parsed.body : ''
          io.send({
            type: 'sidecar_file',
            file_id: file.fileId,
            file_name: fileName,
            mime_type: (typeof file.mimeType === 'string' && file.mimeType) || 'application/octet-stream',
            download_url: file.url,
            expires_in: 90 * 24 * 3600,
            ...(file.mimeType
              ? {
                  knowledge_payload: knowledge?.title && knowledge?.content
                    ? { title: knowledge.title, content: knowledge.content }
                    : { title: fileName, content: body.trim() || `Generated document: ${fileName}` },
                }
              : {}),
          })
        }
      }
    },
  },
  {
    // #176: surface generated charts as images in the message.
    matches: (t) => t === 'render_chart',
    present: (parsed, { io }) => {
      if (typeof parsed.url === 'string' && parsed.url) {
        io.send({
          type: 'chart_created',
          url: parsed.url,
          markdown: typeof parsed.markdown === 'string' ? parsed.markdown : '',
          chart_type: typeof parsed.type === 'string' ? parsed.type : '',
        })
      }
    },
  },
  {
    // #408-followup: scene diagrams render automatically too — previously
    // they only appeared when the model echoed the tool's markdown into its
    // final answer (often omitted), and unlike render_chart there was no SSE
    // projection. Same pipeline: live <img> + chartMeta persistence (#723).
    matches: (t) => t === 'render_scene',
    present: (parsed, { io }) => {
      if (typeof parsed.url === 'string' && parsed.url) {
        io.send({
          type: 'chart_created',
          url: parsed.url,
          markdown: typeof parsed.markdown === 'string' ? parsed.markdown : '',
          chart_type: typeof parsed.pathway_id === 'string' && parsed.pathway_id ? 'reactome' : 'scene',
        })
      }
    },
  },
]

