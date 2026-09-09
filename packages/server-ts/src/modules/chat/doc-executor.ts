/**
 * P0 hotfix 2026-09 — doc 执行器兜底（executor retry）。
 *
 * 生产事故:glm-5.3-flash 在 27k+ 上下文(docHistoryTokens=12k 历史 + 文档
 * 正文 + 规则 + facts)下工具调用可靠性坍塌 — 每轮 completion 17-24k tokens
 * 几乎全是思考,输出纯文本「计划/已落盘」,零工具调用;对照探针 ≤10k 上下文
 * 100% 正常返回原生 tool_calls。原 #892 的"毒上下文内注入纠偏重试"无效
 * (重试仍在同一份 27k 毒上下文里跑)。
 *
 * 本执行器在 tool-loop 正常结束但零写回、且用户消息命中编辑意图时,用
 * 【精简消息】(执行器规则 + 文档全文 + 用户任务 + 既定方案,不含历史/
 * persona/规则/facts)只挂写回工具面(DOC_WRITE_TOOLS)重跑一轮
 * runToolCallLoop;执行器后仍零写回 → 诚实告知用户 + edit_claim_unbacked
 * 留痕(保留 #892 语义)。
 */
import prisma from '../../common/prisma.js'
import { makeLogger } from '../../common/logger.js'
import { fitTextToTokens } from '../../common/token-estimate.js'
import { CONTEXT_CONFIG } from '../../common/context-config.js'
import { parseDocSessionId, type ToolRegistry } from '../../tools/tool-registry.js'
import type { ToolDefinition } from '../../tools/base-tool.js'
import type { getUserContext } from '../shared/user-context.js'
import { runToolCallLoop, DOC_WRITE_TOOLS, type TurnIO } from './tool-loop.js'
import { EXECUTOR_RULE } from './writing-prompts.js'

const log = makeLogger('chat.doc-executor')

/** P0 hotfix: 编辑意图判据 — 用户消息命中即视为"要求动文档"(不区分
 *  语言;大小写不敏感)。 */
export const DOC_EDIT_INTENT_RE = /修改|编辑|删除|插入|整理|润色|重写|重构|调整|扩写|续写|执行|落实|落盘|改好|restructur|reorgan|edit|polish|revise/i

/**
 * 执行器触发判据(纯函数,可单测):
 *   scene 为 doc 会话(sid 前缀 doc-)
 *   && 用户消息命中编辑意图正则
 *   && tool-loop 结果 executedWriteTools 为空(本轮零写回)。
 * 非 doc 会话 / 非编辑意图轮次 / 已有写回 → 一律不触发(零行为回归)。
 */
export function shouldRunDocExecutor(input: {
  sessionId: string
  userText: string
  executedWriteTools: string[]
}): boolean {
  return input.sessionId.startsWith('doc-')
    && input.executedWriteTools.length === 0
    && DOC_EDIT_INTENT_RE.test(input.userText)
}

/** 执行器后仍零写回的诚实告知(#892 语义延伸)。 */
export const DOC_EXECUTOR_FAILED_NOTICE =
  '⚠️ AI 本轮未产生任何文档修改（模型未调用编辑工具）。已自动重试一次仍失败——请重发指令或改用选区润色。'

export interface DocExecutorParams {
  userId: string
  sessionId: string
  /** 原始用户消息(本回合) — 用户任务段。 */
  userText: string
  /** 上轮模型的 finalContent — 既定方案段(纯文本计划)。 */
  planText: string
  apiKey: string
  io: TurnIO
  ctx: Awaited<ReturnType<typeof getUserContext>>
  /** 本回合的 ToolRegistry(edit_document 等执行面)。 */
  toolRegistry: ToolRegistry
  /** 本回合已按场景过滤的工具定义全集 — 执行器内部只保留写回类。 */
  tools: ToolDefinition[]
  /** 模型覆盖(视觉模型自适应,与主回路一致)。 */
  model?: string
}

/**
 * 精简上下文兜底重跑:返回执行器实际执行过的写回工具名单与汇报文本。
 * executedWriteTools 为空 = 执行器也失败(已诚实告知 + 留痕),调用方保持
 * 原 finalContent(执行器已对用户说明"未产生任何修改")。
 */
export async function runDocExecutorFallback(
  params: DocExecutorParams,
): Promise<{ executedWriteTools: string[]; finalContent: string }> {
  const { userId, sessionId, userText, planText, apiKey, io, ctx, toolRegistry, tools } = params
  const empty = { executedWriteTools: [] as string[], finalContent: '' }
  // docId 已有(主回路已解析过);这里再走一次格式校验防御性兜底。
  const docId = parseDocSessionId(sessionId)
  if (!docId) return empty
  // 文档全文从 prisma 直读 — 不经 27k 毒上下文。
  const doc = await prisma.doc.findFirst({ where: { id: docId, userId } }).catch(() => null)
  if (!doc) {
    log.warn('doc executor skipped — document not found', { docId, userId })
    return empty
  }
  // 工具面只保留写回类(edit_document/insert_asset/edit_deck/
  // fix_document_images) — 检索/渲染工具在此无意义,且减少工具面噪声。
  const writeTools = tools.filter((t) => DOC_WRITE_TOOLS.has(t.function.name))
  if (writeTools.length === 0) return empty

  // 精简消息:[system: 执行器规则, user: 文档全文+任务+方案]。不含历史。
  const body = fitTextToTokens(String(doc.body || ''), CONTEXT_CONFIG.scene.docBodyTokens)
  const executorMessages: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: EXECUTOR_RULE },
    {
      role: 'user',
      content: [
        '## 当前文档全文\n',
        body,
        '\n\n## 用户任务\n',
        userText,
        '\n\n## 既定方案（逐项用工具执行）\n',
        planText.trim() || '(无既定方案 — 直接按用户任务执行)',
      ].join('\n'),
    },
  ]

  const loop = await runToolCallLoop({
    currentMessages: executorMessages,
    toolRegistry,
    tools: writeTools,
    apiKey,
    io,
    ctx,
    userId,
    sessionId,
    ...(params.model ? { model: params.model } : {}),
  })

  if (loop.executedWriteTools.length > 0) {
    log.info('doc executor rescue succeeded', {
      sessionId, tools: loop.executedWriteTools, reportChars: loop.finalContent.length,
    })
    return { executedWriteTools: loop.executedWriteTools, finalContent: loop.finalContent }
  }

  // 执行器后仍零写回 → 诚实告知 + 事件留痕(保留 #892 语义)。
  log.warn('doc executor rescue exhausted — zero write-back', { sessionId, docId })
  try {
    ctx.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType: 'edit_claim_unbacked',
      content: `doc-executor retry exhausted: ${userText.slice(0, 160)}`,
      metadata: { executorRetry: true, claimedEdit: true, docWriteExecuted: 0 },
      agentId: userId,
      sessionId,
    })
  } catch { /* 留痕失败不阻断 */ }
  io.send({ type: 'context_info', text: DOC_EXECUTOR_FAILED_NOTICE, kind: 'warning' })
  return { executedWriteTools: [], finalContent: loop.finalContent }
}
