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
import { resolveTurnTimeoutMs } from '../../common/llm-gateway.js'
import { deepseekChatWithMeta, DEEPSEEK_PREMIUM_MODEL } from '../../common/llm.js'
import { detectDoomLoop } from '../../tools/doom-loop.js'
import { READ_ONLY_TOOLS } from '../../tools/tool-registry.js'
import { makeLogger } from '../../common/logger.js'
import { parseLlmJson } from '../../common/llm-json.js'
import type { getUserContext } from '../shared/user-context.js'
// #790: SSE 出口类型化 — 此前 (chunk: any) 使 loop 内新事件绕过编译期
// 检查，契约类型化停在传输层（chat-sse）。
import type { ChatStreamChunk, DeckWire } from '@heurion/contracts'
import { deckWireSchema } from '@heurion/contracts'

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
}

interface ToolResultPresenter {
  matches: (toolName: string) => boolean
  present: (parsed: Record<string, unknown>, env: PresentEnv) => void
}

/** Tools whose output carries a full document body for the writing canvas. */
const DOC_WRITE_TOOLS = new Set(['edit_document', 'insert_asset', 'edit_deck', 'fix_document_images'])

const PRESENTERS: ToolResultPresenter[] = [
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
    present: (parsed, { io, toolName }) => {
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
}): Promise<{ finalContent: string; messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ChatContentPart[] }> }> {
  const { currentMessages, toolRegistry, tools, io, ctx, userId, sessionId } = params
  const turnModel = params.model || DEEPSEEK_PREMIUM_MODEL

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
        const baseDir = process.env.TWIN_BASE_DIR || '.nexus/twins'
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

  while (toolRound < MAX_TOOL_ROUNDS) {
    toolRound++
    // #548: use chatWithMeta (truncation-aware) and the gateway default token
    // budget (MAX_OUTPUT_TOKENS, 8192) instead of a hardcoded 4096.
    const call = await deepseekChatWithMeta(
      messages,
      params.apiKey,
      {
        model: turnModel,
        telemetryContext: { userId, workspaceId: userId, action: 'chat.main' },
        signal: io.signal,
        // #802: doc 会话长生成任务 TTFB 预算放宽到 600s(默认 300s 掐死
        // 整篇扩写类首调用,现场 9/2「扩充完整正文」309s 静默死亡)。
        timeoutMs: resolveTurnTimeoutMs(sessionId),
      },
      tools,
      (reasoning) => io.send({ type: 'reasoning_chunk', text: reasoning }),
    )
    const callResult = call.text

    if (!callResult) {
      finalContent = ''
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
        plan.push({
          kind: 'call',
          call: { toolName, toolArgs, seq: ++toolSeq, argsPreview: String(JSON.stringify(toolArgs) || '').slice(0, 300), startedAt: Date.now() },
        })
      }

      const isSubagent = (t: string) => t === 'delegate'
      const subTaskOf = (c: ExecutableCall) => String((c.toolArgs as any)?.task || c.argsPreview)

      /** #829: pre-execution lifecycle — pending/running 事件 + SSE 芯片 +
       *  doom-loop 检查 + delegate 的 subagent_started。 */
      const startCall = async (c: ExecutableCall) => {
        await appendToolEvent('tool_call', `${c.toolName}(${c.argsPreview})`, {
          tool: c.toolName, args: c.argsPreview, status: 'pending', seq: c.seq,
        })
        // Doom-loop guard: same tool + identical args 3x consecutively.
        if (detectDoomLoop(doomHistory, c.toolName, c.toolArgs)) {
          log.warn('doom-loop detected', { tool: c.toolName, seq: c.seq })
          await appendToolEvent('tool_call', `${c.toolName}(${c.argsPreview})`, {
            tool: c.toolName, args: c.argsPreview, status: 'warning', seq: c.seq,
          })
        }
        io.send({ type: 'tool_call', tool: c.toolName, args: c.toolArgs, seq: c.seq })
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
      }

      /** #829: post-execution lifecycle — 状态机落盘 + tool_result 事件
       *  (seq/elapsed/preview) + 结果注入消息 + presenter 投影。 */
      const finishCall = async (c: ExecutableCall, result: Awaited<ReturnType<typeof toolRegistry.execute>>) => {
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
          toolResultText = summary
            ? `{ body: <updated>, summary: ${JSON.stringify(summary)} }`
            : toolResultText.slice(0, 500)
        }
        messages.push({
          role: 'user',
          content: `Tool "${c.toolName}" returned: ${result.success ? toolResultText : `Error: ${result.error}`}`,
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
        })

        // #789③: per-tool SSE 投影走 presenter 注册表 — 新媒体工具只需
        // 注册一个 presenter,不再往 loop 里加 if 分支。
        if (result.success && parsedOutput) {
          const env: PresentEnv = { io, toolName: c.toolName }
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
          await startCall(call)
          const result = await toolRegistry.execute(call.toolName, call.toolArgs)
          await finishCall(call, result)
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
        for (const c of group) await startCall(c)
        const results = await Promise.all(group.map((c) => toolRegistry.execute(c.toolName, c.toolArgs)))
        for (let k = 0; k < group.length; k++) await finishCall(group[k], results[k])
        executedAny = true
        i = j
      }
      if (executedAny) {
        continue
      }
    }

    // §3.3: never surface raw <tool_call> markers to the user — strip
    // any unparsed blocks before sending the final answer.
    const cleaned = (callResult || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim()
    finalContent = cleaned || '抱歉，我未能完成这个操作，请再试一次或换一种说法描述需求。'
    break
  }

  // 注意:finalContent 为空时不能在这里兜底 — conversation-turn 会走
  // deepseekStream 流式 fallback(511-517 行的 if(finalContent) 分支)。
  // 硬编码兜底文案会截胡流式路径。
  return { finalContent, messages }
}
