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
import { deepseekChatWithMeta, DEEPSEEK_PREMIUM_MODEL } from '../../common/llm.js'
import { detectDoomLoop } from '../../tools/doom-loop.js'
import { makeLogger } from '../../common/logger.js'
import type { getUserContext } from './user-context.js'

const log = makeLogger('chat.tool-loop')

export interface TurnIO {
  send: (chunk: any) => void
  signal: AbortSignal
}

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
      for (const block of toolCallBlocks) {
        let toolCall: any = null
        try {
          toolCall = JSON.parse(block.replace(/<\/?tool_call>/g, '').trim())
        } catch (err) {
          // §3.3: malformed JSON must not crash the turn — tell the model
          // to re-emit a valid call instead of dying silently.
          await appendToolEvent('tool_call', 'malformed_arguments', {
            tool: '?', args: 'parse-failed', status: 'error', seq: ++toolSeq,
          })
          messages.push({ role: 'assistant', content: block })
          messages.push({
            role: 'user',
            content: 'The previous tool call had malformed JSON arguments. Please re-emit the tool call with valid JSON only.',
          })
          continue
        }
        const toolName = toolCall.name || toolCall.tool
        const toolArgs = toolCall.arguments || toolCall.args || {}
        executedAny = true

        toolSeq++
        const seq = toolSeq
        const argsPreview = String(JSON.stringify(toolArgs) || '').slice(0, 300)

        // R3: persist the state machine — pending → running → completed/error.
        await appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
          tool: toolName, args: argsPreview, status: 'pending', seq,
        })

        // Doom-loop guard: same tool + identical args 3x consecutively.
        if (detectDoomLoop(doomHistory, toolName, toolArgs)) {
          log.warn('doom-loop detected', { tool: toolName, seq })
          await appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
            tool: toolName, args: argsPreview, status: 'warning', seq,
          })
        }

        io.send({ type: 'tool_call', tool: toolName, args: toolArgs })

        await appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
          tool: toolName, args: argsPreview, status: 'running', seq,
        })

        // #350: delegate = sub-agent activity — surface started/done
        // over SSE so the UI can show parallel research progress.
        const isSubagent = toolName === 'delegate' || toolName === 'spawn_subagent'
        const subTask = isSubagent ? String((toolArgs as any)?.task || argsPreview) : ''
        if (isSubagent) {
          const scope = String((toolArgs as any)?.scope || 'global')
          io.send({ type: 'subagent_started', task: subTask.slice(0, 200), scope })
        }

        const result = await toolRegistry.execute(toolName, toolArgs)

        // #419: generated images render in the chat stream.
        if (toolName === 'generate_image' && result.success && result.output) {
          try {
            const parsed = JSON.parse(result.output)
            if (parsed.url) {
              io.send({ type: 'image_attached', url: parsed.url, caption: parsed.prompt?.slice(0, 120) })
            }
          } catch { /* non-JSON */ }
        }

        // #418: surface memory-search hits to the doctor (AI 依据可见).
        if (toolName === 'search_node' && result.success && result.output) {
          try {
            const parsed = JSON.parse(result.output)
            const hits = Array.isArray(parsed?.hits) ? parsed.hits : []
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
          } catch { /* non-JSON output */ }
        }

        if (isSubagent) {
          let cost = 0
          if (result.success && result.output) {
            try { cost = Number(JSON.parse(result.output).cost_tokens) || 0 } catch { /* ignore */ }
          }
          io.send({ type: 'subagent_done', task: subTask.slice(0, 200), success: result.success, cost_tokens: cost })
        }

        // #693: edit_document 输出含完整 body(豁免了 bound) — 注入给模型
        // 的内容只保留摘要,避免正文全文每轮循环膨胀上下文;doc_updated
        // 推送在下方用原始 output 完整解析。#765: insert_asset 同管道。
        const DOC_WRITE_TOOLS = new Set(['edit_document', 'insert_asset'])
        let toolResultText = result.output || 'Success'
        if (DOC_WRITE_TOOLS.has(toolName) && result.success) {
          try {
            const parsed = JSON.parse(toolResultText) as { summary?: string }
            toolResultText = `{ body: <updated>, summary: ${JSON.stringify(parsed.summary || '')} }`
          } catch {
            toolResultText = toolResultText.slice(0, 500)
          }
        }
        messages.push({
          role: 'user',
          content: `Tool "${toolName}" returned: ${result.success ? toolResultText : `Error: ${result.error}`}`,
        })

        if (result.success) {
          const output = result.output || ''
          await appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
            tool: toolName, args: argsPreview, status: 'completed', seq,
          })
          await appendToolEvent('tool_result', output, {
            toolCallId: seq, success: true, outputTruncated: output.length > 500,
          })
          // §15.4: surface document write-backs to the writing canvas.
          // #765: insert_asset (表格) 写回与 edit_document 同管道。
          if (DOC_WRITE_TOOLS.has(toolName)) {
            try {
              const parsed = JSON.parse(output) as { body?: string; summary?: string }
              if (typeof parsed.body === 'string') {
                io.send({ type: 'doc_updated', body: parsed.body, summary: parsed.summary || '' })
              }
            } catch {
              // non-JSON output — nothing to surface
            }
          }
          // #176: surface generated charts as images in the message.
          if (toolName === 'render_chart') {
            try {
              const parsed = JSON.parse(output) as { url?: string; markdown?: string; type?: string }
              if (parsed.url) {
                io.send({ type: 'chart_created', url: parsed.url, markdown: parsed.markdown || '', chart_type: parsed.type || '' })
              }
            } catch {
              // non-JSON output — nothing to surface
            }
          }
        } else {
          await appendToolEvent('tool_call', `${toolName}(${argsPreview})`, {
            tool: toolName, args: argsPreview, status: 'error', seq,
          })
          await appendToolEvent('tool_result', result.error || '', {
            toolCallId: seq, success: false, error: (result.error || '').slice(0, 200),
          })
          // #fix: 工具失败不 break — 错误已作为 tool_result 注入消息,
          // 让模型下一轮看到错误后自行修正锚点重试或正常回答用户。
          // 此前直接返回硬编码的 'I tried to use a tool but...'(英文,
          // 与对话上下文无关),生产反馈"前言不搭后语"。doom-loop 已有
          // 3 次同类告警,MAX_TOOL_ROUNDS=5 兜底总轮数。
        }
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
