/**
 * #544 — tool-calling loop, extracted from chat-handler.ts.
 *
 * Owns the tool state machine (pending→running→completed/error), doom-loop
 * detection, sub-agent SSE surfacing and per-tool media events. The caller
 * (chat-handler) supplies the message list, the registry and the SSE sink.
 */
import type { ToolRegistry } from '../../tools/tool-registry.js'
import type { ToolDefinition } from '../../tools/base-tool.js'
import type { ChatContentPart } from '../../common/llm-gateway.js'
import { resolveActiveModel, resolveTurnTimeoutMs } from '../../common/llm-gateway.js'
import { deepseekChatWithMeta, deepseekChatWithToolsStream } from '../../common/llm.js'
import { detectDoomLoop } from '../../tools/doom-loop.js'
import { READ_ONLY_TOOLS, BEST_EFFORT_RETRIEVAL_TOOLS } from '../../tools/tool-registry.js'
import { twinsRoot } from '../../lib/upload-path.js'
import { makeLogger } from '../../common/logger.js'
import { parseLlmJson } from '../../common/llm-json.js'
import type { getUserContext } from '../shared/user-context.js'
// #790: SSE 出口类型化 — 此前 (chunk: any) 使 loop 内新事件绕过编译期
// 检查，契约类型化停在传输层（chat-sse）。
import type { ChatStreamChunk, DeckWire } from '@heurion/contracts'
import { deckWireSchema } from '@heurion/contracts'
// #892: 声明-执行对账 — 判定纯函数外置 writing-prompts(可单测)。
// P0 hotfix 2026-09: 原对话内纠偏重试已移除(毒上下文里重试无效),
// 重试职责移交 doc-executor;tool-loop 只负责留痕与警示。
import { detectUnbackedEditClaim, countClaimedEditItems } from './writing-prompts.js'
import type { TaskPlan } from '@heurion/contracts'
// #976: 任务清单状态与上下文注入（common 层,tools/modules 共用）。
import {
  loadActivePlan,
  autoAdvanceWriteStep,
  markWriteStepFailed,
  planBacklog,
  renderPendingSteps,
} from '../../common/plan-store.js'

const log = makeLogger('chat.tool-loop')

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
interface PresentEnv {
  io: TurnIO
  toolName: string
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
export const DOC_WRITE_TOOLS = new Set(['edit_document', 'insert_asset', 'edit_deck', 'fix_document_images'])

// #927: doc_updated rev — 进程内单调递增计数器,SSE 消费方(writing-editor)
// 据此幂等防乱序(rev 不大于已应用值的写回直接忽略)。
let docWriteRev = 0

// #927: doom-loop 拦截 — 同参三连调用不再照常执行,注入纠偏后由模型
// 换策略或直接向用户说明。
const DOOM_LOOP_CORRECTION = '该工具已以相同参数连续调用 3 次未产生新结果，请更换策略或直接向用户说明'
const DOOM_INTERCEPTED_PREVIEW = '已拦截：相同参数重复调用'

const PRESENTERS: ToolResultPresenter[] = [
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
          hits: hits.slice(0, 10).map((h: any) => ({
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
    present: (parsed, { io, toolName, docRev, docUpdatedAt }) => {
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
          body: parsed.body,
          summary: typeof parsed.summary === 'string' ? parsed.summary : '',
          ...(parsed.deck !== undefined ? { deck } : {}),
          // #927: 版本标识 — 前端按 rev 幂等防乱序(rev ≤ 已应用值忽略)。
          ...(docRev !== undefined ? { rev: docRev, updatedAt: docUpdatedAt } : {}),
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
]

/**
 * Tool-calling loop: up to MAX_TOOL_ROUNDS rounds of <tool_call> execution.
 * Owns the tool state machine (pending→running→completed/error), doom-loop
 * detection, sub-agent SSE surfacing and per-tool media events.
 */
export async function runToolCallLoop(params: {
  currentMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }>
  toolRegistry: ToolRegistry
  tools: ToolDefinition[]
  apiKey: string
  io: TurnIO
  ctx: Awaited<ReturnType<typeof getUserContext>>
  userId: string
  sessionId: string
  /** #fix: 本回合模型覆盖(视觉模型自适应) — 缺省用 DEEPSEEK_PREMIUM_MODEL。 */
  model?: string
}): Promise<{
  finalContent: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }>
  /** P0 hotfix 2026-09: 本轮实际执行过的 DOC_WRITE_TOOLS 名单(去重) —
   *  doc-executor 兜底触发判据之一(零写回 + 编辑意图 → 精简重试)。 */
  executedWriteTools: string[]
  /** #967: 部分执行对账缺口 — 回复声称完成条目数 > 实际写回数时的
   *  claimed 数(=0 表示对账一致),doc-executor 依此触发部分接力重试。 */
  unbackedClaimCount: number
  /** #977: 写回执行统计 — doc-executor 连败直通触发条件
   *  （尝试 ≥2 且成功 0 → 不等 doom-loop/模型收尾,直接精简兜底）。 */
  writeAttempts: number
  writeSuccesses: number
  /** #976: 活跃任务清单缺口（pending+failed 步数;0=无清单或已清零）—
   *  conversation-turn 依此触发执行器接力;planPendingText 为接力方案段。 */
  planBacklogCount: number
  planPendingText: string
}> {
  const { currentMessages, toolRegistry, io, ctx, userId, sessionId } = params
  // #fix 2026-09: 缺省走 resolveActiveModel()(admin 覆盖 → env → legacy) —
  // 此前硬编码 DEEPSEEK_PREMIUM_MODEL('deepseek-v4-flash'),生产主模型
  // glm-5.3-flash 被绕过且该模型在 Console Go 上游不稳定。
  const turnModel = params.model || resolveActiveModel()

  // R3 — tool-call persistence: per-session sequence numbers continue
  // across turns (and process restarts) by deriving from the log.
  const existingToolEvents = ctx.eventLog.query({ sessionId }).filter((e: any) => e.eventType === 'tool_call')
  let toolSeq = existingToolEvents.length
  const doomHistory: Array<{ tool: string; argsKey: string }> = []

  // #658: write-time truncation — tool outputs are capped on write so the
  // event log (and every LLM context that reads it: history / extraction /
  // compaction) stays bounded without a separate prune pass. Oversized
  // outputs spill to the per-user truncation dir; the event keeps a preview
  // plus the disk path so a future "view full output" flow can recover it.
  const TRUNCATE_CHARS = 500
  const appendToolEvent = async (eventType: string, content: string, metadata: Record<string, unknown>) => {
    let body = content
    if (eventType === 'tool_result' && body.length > TRUNCATE_CHARS) {
      try {
        const { mkdir, writeFile } = await import('fs/promises')
        const { join } = await import('path')
        const baseDir = twinsRoot()
        const dir = join(baseDir, userId, 'truncation')
        await mkdir(dir, { recursive: true })
        const name = `tool_${sessionId.replace(/[^\w-]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
        await writeFile(join(dir, name), content, 'utf-8')
        body = `[Tool output truncated to ${TRUNCATE_CHARS} chars — full output spilled to ${name}]\n${content.slice(0, TRUNCATE_CHARS)}`
        metadata = { ...metadata, truncatedTo: TRUNCATE_CHARS, spillFile: name }
      } catch {
        body = content.slice(0, TRUNCATE_CHARS)
      }
    }
    ctx.eventLog.append({
      timestamp: Date.now() / 1000,
      eventType,
      content: body,
      metadata,
      agentId: userId,
      sessionId,
    })
  }

  let messages = [...currentMessages]
  const MAX_TOOL_ROUNDS = 5
  let toolRound = 0
  let finalContent = ''

  // #892: 声明-执行对账守卫 — 统计本轮写回工具(DOC_WRITE_TOOLS)实际执行
  // 次数(成功或失败都算「已执行」);doc- 会话零执行且回复声称完成编辑时
  // 留痕警示(原对话内纠偏重试已移交 doc-executor)。
  let docWriteExecuted = 0
  // #977: 成功写回单独计数 — 失败执行不算「写回」（空参 edit_document
  // 连败后,失败执行曾把零写回守卫与部分对账的口径带偏:文档未被修改
  // 却有 executed 计数）。守卫判定一律用 succeeded 口径。
  let docWriteSucceeded = 0
  // P0 hotfix 2026-09: 本轮实际执行过的写回工具名单 — 供调用方
  // (conversation-turn → doc-executor)判断"声称完成但零写回"并触发
  // 精简上下文兜底重试。去重,顺序为首次执行顺序。
  const executedWriteToolNames: string[] = []
  // #893: 轮次上限提示 — doc- 会话按轮次耗尽退出(而非模型主动收尾)且
  // 本轮执行过工具时,告知用户可回复「继续」接力完成剩余编辑。
  let anyToolExecuted = false
  // while 自然结束(轮次耗尽)保持 true;break 出口(模型主动收尾/空回复/
  // 守卫后续 break)置 false。
  let exitedByRoundCap = true
  // #967: 部分执行对账缺口 — 守卫检出「声称 > 实际写回」时记录 claimed 数。
  let unbackedClaimCount = 0
  // #972: 活跃清单收尾对账 — backlog > 0 且收尾声称完成时警示并透出接力材料。
  let planBacklogCount = 0
  let planPendingText = ''
  // #978: 写回连败早退标志（finishCall 内置位,walker 检查后 break）。
  let writeFailStreakExit = false

  // #835: 尽最大努力检索(best-effort retrieval) — 检索工具连续失败 ≥2 次
  // 即从后续轮次移除这些工具(模型物理上无法再重试),配合注入指引让模型
  // 基于已有上下文继续完成任务。finalContent 为空时 conversation-turn 的
  // 无工具流式兜底会读到这些指引,产出"最佳努力"回答而非空转。
  let activeTools = [...params.tools]
  // #837: 降级按工具粒度计数 — visit_medical_site 连续失败只停它自己,
  // 不再连坐 search_citation(生产实例:模型误用 visit 抓 NCBI API 两次 →
  // 全部检索工具被停用 → PubMed 明明可用却被判"已停用")。
  const retrievalFailuresByTool = new Map<string, number>()
  const degradedTools = new Set<string>()

  while (toolRound < MAX_TOOL_ROUNDS) {
    toolRound++
    // #fix 2026-09: 工具回合流式调用 — 中转站(opencode Go)模式下非流式是
    // 结构性缺陷: 零字节直到完整生成,整篇重写类大任务(thinking+工具参数
    // 5-10 分钟)被中转层 CF(~100s 掐 → "fetch failed")与本地 TTFB 超时
    // (600s 掐 → "LLM request timed out")双重杀死。流式让字节持续流动,
    // reasoning 实时可见(用户还能看到思维链推进)。流式失败(上游不支持
    // tools-over-stream)回退非流式一次。
    const turnCallOptions = {
      model: turnModel,
      telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
      signal: io.signal,
      // #fix 2026-09: OpenCode Go 要求 per-conversation 会话头(x-opencode-session)。
      sessionId,
      // #802: doc 会话长生成任务 TTFB 预算放宽到 600s(默认 300s 掐死
      // 整篇扩写类首调用,现场 9/2「扩充完整正文」309s 静默死亡)。
      timeoutMs: resolveTurnTimeoutMs(sessionId),
    }
    const onTurnReasoning = (reasoning: string) => io.send({ type: 'reasoning_chunk', text: reasoning })
    let call
    try {
      call = await deepseekChatWithToolsStream(messages, params.apiKey, turnCallOptions, activeTools, onTurnReasoning)
    } catch (streamErr) {
      log.warn(`[tool-loop] tools-stream failed → non-streaming fallback: ${(streamErr as Error).message.slice(0, 120)}`)
      call = await deepseekChatWithMeta(messages, params.apiKey, turnCallOptions, activeTools, onTurnReasoning)
    }
    const callResult = call.text

    if (!callResult) {
      finalContent = ''
      exitedByRoundCap = false
      break
    }

    // Parse JSON response — DeepSeek returns plain text; check for function calls in the text.
    // Match all <tool_call> blocks (each may contain nested JSON in `arguments`).
    const toolCallBlocks = callResult.match(/<tool_call>([\s\S]*?)<\/tool_call>/g)
    // #548: the final answer hit the output token budget — tell the user the
    // reply was cut off instead of silently presenting a half answer. An
    // empty callResult means the reasoning burned the budget (the gateway
    // auto-retried already) — explain, don't leave a blank turn.
    if (call.truncated && (!toolCallBlocks || toolCallBlocks.length === 0)) {
      io.send({
        type: 'truncated',
        message: callResult.trim()
          ? '回答因输出长度限制被截断，请重试或简化问题'
          : '回答在思考阶段被输出限制中断，未能生成内容，请重试或简化问题',
      })
    }
    if (toolCallBlocks && toolCallBlocks.length > 0) {
      let executedAny = false
      // The assistant message must appear ONCE regardless of how many
      // tool calls it contains — re-pushing it per block would duplicate
      // the whole payload N times and corrupt the turn history.
      messages.push({ role: 'assistant', content: callResult })

      // #829: parse every block up front. Malformed JSON gets its
      // correction injected in block order; executable calls get a
      // per-session seq (SSE chip identity) at plan time.
      type ExecutableCall = { toolName: string; toolArgs: Record<string, unknown>; seq: number; argsPreview: string; startedAt: number }
      const plan: Array<{ kind: 'malformed'; block: string } | { kind: 'call'; call: ExecutableCall }> = []
      for (const block of toolCallBlocks) {
        // #694: parseLlmJson — 模型在 <tool_call> 内夹围栏/闲话时同样容错。
        const toolCall = parseLlmJson<Record<string, unknown>>(block.replace(/<\/?tool_call>/g, '').trim())
        if (!toolCall) {
          plan.push({ kind: 'malformed', block })
          continue
        }
        const toolName = String(toolCall.name || toolCall.tool || '')
        const toolArgs = (toolCall.arguments || toolCall.args || {}) as Record<string, unknown>
        // #979 诊断:空参工具调用 — 记录到达 tool-loop 的原始块文本,
        // 二分「网关装配层丢参」vs「模型/中转产出即空」。
        if (
          (DOC_WRITE_TOOLS.has(toolName) || toolName === 'set_task_plan')
          && Object.keys(toolArgs).length === 0
        ) {
          log.warn(`[tool-loop] empty-args tool call — raw block: ${block.slice(0, 300)}`)
        }
        plan.push({
          kind: 'call',
          call: { toolName, toolArgs, seq: ++toolSeq, argsPreview: String(JSON.stringify(toolArgs) || '').slice(0, 300), startedAt: Date.now() },
        })
      }

      const isSubagent = (t: string) => t === 'delegate'
      const subTaskOf = (c: ExecutableCall) => String((c.toolArgs as any)?.task || c.argsPreview)

      /**
       * #829: pre-execution lifecycle — pending/running 事件 + SSE 芯片 +
       * doom-loop 检查 + delegate 的 subagent_started。
       * #927: 返回 true = doom-loop 命中,调用方必须跳过执行(拦截优先于
       * 一切后置逻辑,含检索类 best-effort 降级 — 后者在 finishCall 内,
       * 被本次拦截自然短路)。
       */
      const startCall = async (c: ExecutableCall): Promise<boolean> => {
        await appendToolEvent('tool_call', `${c.toolName}(${c.argsPreview})`, {
          tool: c.toolName, args: c.argsPreview, status: 'pending', seq: c.seq,
        })
        // Doom-loop guard: same tool + identical args 3x consecutively.
        let doomBlocked = false
        if (detectDoomLoop(doomHistory, c.toolName, c.toolArgs)) {
          doomBlocked = true
          log.warn('doom-loop detected', { tool: c.toolName, seq: c.seq })
          await appendToolEvent('tool_call', `${c.toolName}(${c.argsPreview})`, {
            tool: c.toolName, args: c.argsPreview, status: 'warning', seq: c.seq,
          })
        }
        io.send({ type: 'tool_call', tool: c.toolName, args: c.toolArgs, seq: c.seq, round: toolRound })
        // #927: 拦截 — 不发 running/子代理事件,不执行(调用方注入纠偏)。
        if (doomBlocked) return true
        await appendToolEvent('tool_call', `${c.toolName}(${c.argsPreview})`, {
          tool: c.toolName, args: c.argsPreview, status: 'running', seq: c.seq,
        })
        // #350/#831: delegate = sub-agent activity — id 由 loop 生成，
        // spawn_subagent 的 started/progress/done 改由工具内部按子任务
        // 各自上报（批量扇出时一 call 多 id）。
        if (isSubagent(c.toolName)) {
          const scope = String((c.toolArgs as any)?.scope || 'global')
          io.send({ type: 'subagent_started', id: `sub_${c.seq}`, task: subTaskOf(c).slice(0, 200), scope })
        }
        return false
      }

      /** #927: doom-loop 拦截收尾 — 芯片按 seq 闭合 + 事件留痕 + 纠偏消息入上下文。 */
      const interceptDoomCall = async (c: ExecutableCall) => {
        io.send({
          type: 'tool_result',
          seq: c.seq,
          tool: c.toolName,
          success: false,
          elapsed_ms: 0,
          preview: DOOM_INTERCEPTED_PREVIEW,
          round: toolRound,
        })
        await appendToolEvent('tool_result', DOOM_LOOP_CORRECTION, {
          toolCallId: c.seq, success: false, error: 'doom-loop intercepted',
        })
        messages.push({ role: 'user', content: DOOM_LOOP_CORRECTION })
      }

      /** #829: post-execution lifecycle — 状态机落盘 + tool_result 事件
       *  (seq/elapsed/preview) + 结果注入消息 + presenter 投影。 */
      const finishCall = async (c: ExecutableCall, result: Awaited<ReturnType<typeof toolRegistry.execute>>) => {
        // #892: 写回工具每次真实执行(成功或失败)都计入 — 对账守卫的
        // "文档是否被修改过"事实依据。
        if (DOC_WRITE_TOOLS.has(c.toolName)) {
          docWriteExecuted++
          if (result.success) docWriteSucceeded++
          // P0 hotfix 2026-09: 写回工具名单(去重)。
          if (!executedWriteToolNames.includes(c.toolName)) executedWriteToolNames.push(c.toolName)
          // #976 闸门 3 — 写回步骤系统自动推进/失败标注（反编造核心）：
          // 活跃清单中第一个 pending 且 tool 匹配的步骤,系统在真实执行后
          // 推进/标失败,模型无法自行声称写回步骤完成。同步 await（一次
          // DB 查询 ~ms）保证 SSE 与 DB 状态在工具结果事件前一致。
          try {
            const planStep = result.success
              ? await autoAdvanceWriteStep(userId, sessionId, c.toolName)
              : await markWriteStepFailed(userId, sessionId, c.toolName, (result.error || '').slice(0, 200))
            if (planStep) {
              io.send({
                type: 'plan_updated',
                plan: planStep as never,
                kind: result.success ? 'advanced' : 'failed',
                source: 'system',
                progress: { done: planStep.steps.filter((s: { status?: string }) => s.status === 'done').length, total: planStep.steps.length },
              })
            }
          } catch { /* 清单联动失败不阻断工具流 */ }
          // #978: 写回连败早退 — doc- 会话写回尝试 ≥2 且成功 0 时,毒上下文
          // 内的继续重试已被证伪(#892/doom-loop 拦截后模型仍空参连发),
          // 立即结束循环,转入 doc-executor 精简兜底（连败直通条件接手）。
          if (sessionId.startsWith('doc-') && docWriteSucceeded === 0 && docWriteExecuted - docWriteSucceeded >= 2) {
            io.send({
              type: 'context_info',
              text: '写回连续失败 — 转入精简上下文自动重试',
              kind: 'warning',
            })
            exitedByRoundCap = false
            writeFailStreakExit = true
          }
        }
        // #789③/#694: parse the tool output ONCE per result —此前
        // generate_image/search_node/insert_asset/render_chart 各自
        // JSON.parse 同一份 output(insert_asset 单轮 3 次),逐处静默
        // catch。parseLlmJson 带 fence 容错;非 JSON 输出为 null,
        // presenter 自然跳过。
        const parsedOutput = (result.success && result.output)
          ? parseLlmJson<Record<string, unknown>>(result.output)
          : null

        // #350: sub-agent done — 成败都要发(cost 仅成功时有值)。
        if (isSubagent(c.toolName)) {
          const cost = parsedOutput ? Number(parsedOutput.cost_tokens) || 0 : 0
          io.send({ type: 'subagent_done', id: `sub_${c.seq}`, task: subTaskOf(c).slice(0, 200), success: result.success, cost_tokens: cost })
        }

        // #693: edit_document 输出含完整 body(豁免了 bound) — 注入给模型
        // 的内容只保留摘要,避免正文全文每轮循环膨胀上下文。#765:
        // insert_asset 同管道。#773: edit_deck 同管道。#fix 2026-09:
        // fix_document_images 同管道。摘要取自共享 parsedOutput,不再重解析。
        let toolResultText = result.output || 'Success'
        if (DOC_WRITE_TOOLS.has(c.toolName) && result.success) {
          const summary = typeof parsedOutput?.summary === 'string' ? parsedOutput.summary : ''
          // #927: summary 缺失时固定占位 — 不再把原文前 500 字符切片注入
          // 模型上下文(与 SSE tool_result preview 的「文档已写回」同语义)。
          toolResultText = summary
            ? `{ body: <updated>, summary: ${JSON.stringify(summary)} }`
            : '文档已写回（无摘要）'
        }
        // #835: 检索类失败注入"尽最大努力"指引 — 失败不阻塞任务,禁止
        // 换参反复重试,基于已有上下文继续并如实标注未核实来源。
        // #837: 按工具计数(降级只停连败的工具本身)。
        const isRetrievalFailure = !result.success && BEST_EFFORT_RETRIEVAL_TOOLS.has(c.toolName)
        if (isRetrievalFailure) {
          retrievalFailuresByTool.set(c.toolName, (retrievalFailuresByTool.get(c.toolName) || 0) + 1)
        }
        const retrievalGuidance = isRetrievalFailure
          ? '\n【检索兜底策略】检索失败不阻塞任务：请勿再用不同参数重试同一工具（连续失败会被系统停用该工具）；请基于已有上下文与自身知识继续完成用户请求；如需引用，请在文中如实标注"来源未能核实"。'
          : ''
        messages.push({
          role: 'user',
          content: `Tool "${c.toolName}" returned: ${result.success ? toolResultText : `Error: ${result.error}${retrievalGuidance}`}`,
        })

        if (result.success) {
          const output = result.output || ''
          await appendToolEvent('tool_call', `${c.toolName}(${c.argsPreview})`, {
            tool: c.toolName, args: c.argsPreview, status: 'completed', seq: c.seq,
          })
          await appendToolEvent('tool_result', output, {
            toolCallId: c.seq, success: true, outputTruncated: output.length > 500,
          })
        } else {
          await appendToolEvent('tool_call', `${c.toolName}(${c.argsPreview})`, {
            tool: c.toolName, args: c.argsPreview, status: 'error', seq: c.seq,
          })
          await appendToolEvent('tool_result', result.error || '', {
            toolCallId: c.seq, success: false, error: (result.error || '').slice(0, 200),
          })
          // #fix: 工具失败不 break — 错误已作为 tool_result 注入消息,
          // 让模型下一轮看到错误后自行修正锚点重试或正常回答用户。
          // doom-loop 已有 3 次同类告警,MAX_TOOL_ROUNDS=5 兜底总轮数。
        }

        // #835: 连续 ≥2 次检索失败 — 从后续轮次移除"该工具"(模型物理上
        // 无法再重试),配合注入指引让模型基于已有资料继续(事件留痕)。
        // #837: 只停连败的工具本身 — 其他检索工具(PubMed/知识库等)保持可用。
        for (const [toolName, failures] of retrievalFailuresByTool) {
          if (failures < 2 || degradedTools.has(toolName)) continue
          if (!BEST_EFFORT_RETRIEVAL_TOOLS.has(toolName)) continue
          degradedTools.add(toolName)
          activeTools = activeTools.filter((t) => t.function.name !== toolName)
          log.warn('best-effort retrieval: disabling repeatedly failing tool', {
            sessionId, failedTool: toolName, failures,
          })
          try {
            await appendToolEvent('tool_call', `retrieval_degraded:${toolName}`, {
              tool: 'system', args: toolName, status: 'warning', seq: ++toolSeq,
            })
          } catch { /* best-effort */ }
          messages.push({
            role: 'user',
            content: `【系统】检索工具 ${toolName} 已因连续失败被停用。其他检索工具仍可用（如适用请改用它们）；请直接基于已有上下文、已注入的知识片段与你的专业知识继续完成用户请求；涉及外部资料的部分请如实标注"来源未能核实"。`,
          })
        }

        // #829: tool_result SSE — 前端按 seq 闭合芯片并展示结果摘要。
        const preview = !result.success
          ? (result.error || '').split('\n')[0].slice(0, 80)
          : DOC_WRITE_TOOLS.has(c.toolName)
            ? (typeof parsedOutput?.summary === 'string' && parsedOutput.summary ? parsedOutput.summary.slice(0, 80) : '文档已写回')
            : (result.output || '').split('\n')[0].slice(0, 80)
        io.send({
          type: 'tool_result',
          seq: c.seq,
          tool: c.toolName,
          success: result.success,
          elapsed_ms: Date.now() - c.startedAt,
          preview: preview || undefined,
          round: toolRound,
        })

        // #789③: per-tool SSE 投影走 presenter 注册表 — 新媒体工具只需
        // 注册一个 presenter,不再往 loop 里加 if 分支。
        if (result.success && parsedOutput) {
          // #927: doc_updated 版本标识 — rev 进程内单调递增,updatedAt 取
          // 写回完成时刻(SSE 投影即写回后瞬间)。
          const env: PresentEnv = {
            io,
            toolName: c.toolName,
            ...(DOC_WRITE_TOOLS.has(c.toolName)
              ? { docRev: ++docWriteRev, docUpdatedAt: new Date().toISOString() }
              : {}),
          }
          for (const presenter of PRESENTERS) {
            if (presenter.matches(c.toolName)) presenter.present(parsedOutput, env)
          }
        }
      }

      // #829: walk the plan — consecutive READ-ONLY calls run in parallel
      // (Promise.all), everything else stays serial in block order. Results
      // (messages/events/SSE) are applied in original order, so the model
      // sees a deterministic transcript.
      let i = 0
      while (i < plan.length) {
        const item = plan[i]
        if (item.kind === 'malformed') {
          // §3.3: malformed JSON must not crash the turn — tell the model
          // to re-emit a valid call instead of dying silently.
          await appendToolEvent('tool_call', 'malformed_arguments', {
            tool: '?', args: 'parse-failed', status: 'error', seq: ++toolSeq,
          })
          messages.push({ role: 'assistant', content: item.block })
          messages.push({
            role: 'user',
            content: 'The previous tool call had malformed JSON arguments. Please re-emit the tool call with valid JSON only.',
          })
          i++
          continue
        }
        const call = item.call
        if (!READ_ONLY_TOOLS.has(call.toolName)) {
          const blocked = await startCall(call)
          if (blocked) {
            // #927: doom-loop 拦截 — 跳过执行,注入纠偏,下一轮换策略。
            await interceptDoomCall(call)
          } else {
            const result = await toolRegistry.execute(call.toolName, call.toolArgs)
            await finishCall(call, result)
          }
          executedAny = true
          i++
          continue
        }
        const group: ExecutableCall[] = [call]
        let j = i + 1
        while (j < plan.length) {
          const nxt = plan[j]
          if (nxt.kind === 'call' && READ_ONLY_TOOLS.has(nxt.call.toolName)) {
            group.push(nxt.call)
            j++
          } else break
        }
        // #927: doom 拦截优先 — 命中的调用不进执行批次,原 block 顺序注入纠偏。
        const blockedFlags: boolean[] = []
        for (const c of group) blockedFlags.push(await startCall(c))
        const runnable = group.filter((_, idx) => !blockedFlags[idx])
        const results = await Promise.all(runnable.map((c) => toolRegistry.execute(c.toolName, c.toolArgs)))
        let runIdx = 0
        for (let k = 0; k < group.length; k++) {
          if (blockedFlags[k]) await interceptDoomCall(group[k])
          else await finishCall(group[k], results[runIdx++])
        }
        executedAny = true
        i = j
      }
      // #978: 写回连败早退 — finishCall 内置位,直接结束轮次循环
      // （walker 的 break 只出计划遍历;这里出轮次循环转 doc-executor 兜底）。
      if (writeFailStreakExit) {
        exitedByRoundCap = false
        break
      }
      if (executedAny) {
        anyToolExecuted = true
        continue
      }
    }

    // §3.3: never surface raw <tool_call> markers to the user — strip
    // any unparsed blocks before sending the final answer.
    const cleaned = (callResult || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
    finalContent = cleaned || '抱歉，我未能完成这个操作，请再试一次或换一种说法描述需求。'

    // #892: 声明-执行对账守卫(生产事故根因①) — doc- 会话对话正常结束,
    // 没有任何写回工具执行,回复却声称已完成编辑:事件留痕 + 用户可见警示。
    // P0 hotfix 2026-09: 原「注入纠偏消息后重试一轮」已移除 — 纠偏重试
    // 仍跑在同一份 27k+ 毒上下文里,实测无效(模型继续输出计划文本);
    // 重试职责移交 doc-executor(精简上下文 + 仅写回工具面重跑,见
    // conversation-turn 的接线)。此处只留痕,不动 finalContent。
    // #967: 部分执行对账 — 写回次数 ≥1 但回复(对照表/进度话术)声称完成
    // 的条目数超过实际写回数(生产实例:长文档逐段协议下只写了第 1 节,
    // 对照表给其余 7 节编造「实际改动」),同样留痕 + 警示 + 暴露缺口数
    // 供 doc-executor 接力。
    if (sessionId.startsWith('doc-')) {
      // #972: 活跃任务清单收尾对账 — backlog（pending+failed 步）> 0 且
      // 收尾命中完成声明 → 警示 + 事件 + 接力材料（替代文本解析启发式）。
      const activePlan = await loadActivePlan(userId, sessionId).catch(() => null)
      const backlog = planBacklog(activePlan)
      planBacklogCount = backlog
      planPendingText = renderPendingSteps(activePlan)
      const claimedCount = countClaimedEditItems(finalContent)
      // #977: 守卫口径统一为「成功写回」——失败执行不算写回（文档未被
      // 修改的事实依据）。
      // 分支序：零写回（最严重）→ 清单 backlog → 文本计数部分执行。
      if (docWriteSucceeded === 0 && detectUnbackedEditClaim(finalContent)) {
        await appendToolEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
          claimedEdit: true,
          docWriteExecuted,
          docWriteSucceeded,
          ...(backlog > 0 ? { planBacklog: backlog } : {}),
        })
        io.send({
          type: 'context_info',
          text: backlog > 0
            ? `⚠️ 上面的回复声称已完成文档编辑，但本轮无成功写回，且任务清单仍有 ${backlog} 步未完成 — 文档未被修改`
            : '⚠️ 上面的回复声称已完成文档编辑，但本轮未产生任何成功写回，文档未被修改',
          kind: 'warning',
        })
        unbackedClaimCount = Math.max(claimedCount, backlog)
      } else if (backlog > 0 && detectUnbackedEditClaim(finalContent)) {
        await appendToolEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
          kind: 'plan_backlog',
          planId: activePlan?.plan_id,
          backlog,
          docWriteSucceeded,
        })
        io.send({
          type: 'context_info',
          text: `⚠️ 上面的回复声称已完成文档编辑，但任务清单仍有 ${backlog} 步未完成 — 可回复「继续」从剩余步骤接着执行`,
          kind: 'warning',
        })
        unbackedClaimCount = Math.max(unbackedClaimCount, backlog)
      } else if (claimedCount > docWriteSucceeded) {
        await appendToolEvent('edit_claim_unbacked', finalContent.slice(0, 200), {
          claimedCount,
          docWriteSucceeded,
          kind: 'partial',
        })
        io.send({
          type: 'context_info',
          text: `⚠️ 上面的回复声称已完成 ${claimedCount} 处编辑，但本轮实际写回 ${docWriteSucceeded} 处 — 其余条目未写入文档。可回复「继续」让 AI 执行剩余部分`,
          kind: 'warning',
        })
        unbackedClaimCount = claimedCount
      }
    }

    exitedByRoundCap = false
    break
  }

  // #893: doc- 会话轮次耗尽(模型连跑 5 轮工具仍未收尾) — 告知用户剩余
  // 编辑可回复「继续」接力,不再静默截断(事故根因②)。
  if (exitedByRoundCap && sessionId.startsWith('doc-') && anyToolExecuted) {
    io.send({
      type: 'context_info',
      text: '本轮编辑轮次已达上限（5 轮），若回复中尚有未执行的编辑，请回复“继续”让 AI 完成剩余部分',
      kind: 'warning',
    })
  }

  // 注意:finalContent 为空时不能在这里兜底 — conversation-turn 会走
  // deepseekStream 流式 fallback(511-517 行的 if(finalContent) 分支)。
  // 硬编码兜底文案会截胡流式路径。
  return { finalContent, messages, executedWriteTools: executedWriteToolNames, unbackedClaimCount, writeAttempts: docWriteExecuted, writeSuccesses: docWriteSucceeded, planBacklogCount, planPendingText }
}
