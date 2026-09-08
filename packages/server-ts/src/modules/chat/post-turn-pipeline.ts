/**
 * #846 — 回合后处理管线(post-turn pipeline)。
 *
 * runConversationTurn 的终了段此前堆积了 10 个各自 try/catch + 动态 import
 * 的后处理(引用对账/落盘/轨迹/遵循度/演化投递/患者分析/会话行/引用
 * chips/技能建议),新增后处理只能往主路径中间插代码。收敛为有序段注册
 * (与 ContextAssembler 的 builder 注册模式一致):
 *  - 段级耗时 telemetry + 段级失败日志(best-effort 段互不阻断);
 *  - critical 段(assistant_response 落盘/upsert-session)失败向上抛,
 *    保持 #185「回合不丢」语义;
 *  - 段间数据经 PostTurnContext 传递(消除闭包耦合)。
 */
import { makeLogger } from '../../common/logger.js'
import type { EvolutionQueue } from '../evolution/evolution.queue.js'
import type { SendEvent } from './chat-sse.js'
import type { TurnIntent } from './turn-intent.js'
import type { ChatScene } from '../../common/persona.js'
import type { getUserContext } from '../shared/user-context.js'
import { upsertSessionRow } from './history-budget.js'
import { detectUnbackedEditClaim } from './writing-prompts.js'
import { analyzeChatForMedicalRecord, updatePatientFromFindings, updateMedicalRecordFromChat } from '../patients/clinical-analysis.js'

const log = makeLogger('chat.post-turn')

type UserContext = Awaited<ReturnType<typeof getUserContext>>

export interface PostTurnContext {
  ctx: UserContext
  userId: string
  sessionId: string
  scene: ChatScene
  bodyText: string
  turnIntent: TurnIntent
  fullResponse: string
  /** 引用对账(citation-audit)可改写的落盘文本 — 初始= fullResponse。 */
  responseForLog: string
  kbCitations: Array<{ kind: 'fact' | 'knowledge' | 'document'; label: string; sourceId: string }>
  timelineTools: Array<{ tool: string; round?: number }>
  chartMeta: Array<{ url: string; chartType?: string }>
  timelineSubs: Array<{ id: string; task: string; status: 'running' | 'done' | 'failed' }>
  skillCards: any[]
  attachmentText: string
  patientHash: string | null
  evolutionQueue?: EvolutionQueue
  send: SendEvent
}

export interface PostTurnSegment {
  name: string
  /** critical 段失败向上抛(#185 回合不丢);默认 best-effort。 */
  critical?: boolean
  run: (c: PostTurnContext) => Promise<void> | void
}

/** #2/#879-era: 患者聊天分析限流 — 每 patientHash ≥15s 一次。 */
const chatAnalysisThrottle = new Map<string, number>()

export const POST_TURN_SEGMENTS: PostTurnSegment[] = [
  {
    name: 'citation-audit',
    // #839 缺口 2: 记忆引用输出侧对账 — 输出中的 KB 引用标注(（来源：《标题》）)
    // 必须命中本轮注入集合;未命中的降级"未溯源"标注并 SSE 上报,不静默。
    run: async (c) => {
      const { auditMemoryCitations, titlesFromCitationLabels } = await import('../../modules/knowledge/citation-audit.js')
      const audit = auditMemoryCitations(c.responseForLog, titlesFromCitationLabels(c.kbCitations.map((x) => x.label)))
      if (audit.unverified.length > 0) {
        c.responseForLog = audit.annotatedText
        c.send({
          type: 'citation_audit',
          total: audit.total,
          verified: audit.verified,
          unverified: audit.unverified.map((u) => u.title).slice(0, 5),
          message: `检测到 ${audit.unverified.length} 处引用未命中本轮注入的知识库条目，已标注"未溯源"`,
        })
      }
    },
  },
  {
    name: 'persist-assistant',
    critical: true,
    // #185: user_message 已前置落库 — 助手响应落盘失败必须向上抛(回合不丢)。
    // #832-缺3: timeline 快照(有界)随 metadata 落库 — 刷新后前端重建时间线。
    run: async (c) => {
      const timelineMeta: Record<string, unknown> = {}
      if (c.chartMeta.length > 0) timelineMeta.chart = c.chartMeta
      if (c.timelineTools.length > 0 || c.timelineSubs.length > 0) {
        timelineMeta.timeline = {
          ...(c.timelineTools.length > 0 ? { tools: c.timelineTools } : {}),
          ...(c.timelineSubs.length > 0 ? { subagents: c.timelineSubs } : {}),
        }
      }
      c.ctx.eventLog.append({
        timestamp: Date.now() / 1000, eventType: 'assistant_response', content: c.responseForLog,
        metadata: timelineMeta, agentId: c.userId, sessionId: c.sessionId,
      })
    },
  },
  {
    name: 'task-trajectory',
    // #843 环①: 任务轨迹采集 — 仅任务型回合(edit/generate/retrieve/command),
    // answer 不记(D1: eventLog 投影,零正文,零 LLM/零外呼)。
    run: async (c) => {
      const { recordTaskTrajectory } = await import('../../evolution/trajectory.js')
      const docEdits = c.timelineTools.filter((t) => t.tool === 'edit_document').length
      // #892: 声明-执行对账(生产事故根因①) — doc- 会话零写回且回复声称
      // 已完成编辑 → outcome 标记 claimed_no_edit(轨迹层可见的"未兑现
      // 声明",喂环②归纳;非 doc 会话的「已完成」属普通任务汇报,不标记)。
      const claimedNoEdit = c.sessionId.startsWith('doc-')
        && docEdits === 0
        && detectUnbackedEditClaim(c.fullResponse)
      recordTaskTrajectory(c.ctx.eventLog, {
        userId: c.userId,
        sessionId: c.sessionId,
        action: c.turnIntent.action,
        scene: c.scene,
        toolsUsed: c.timelineTools.map((t) => t.tool),
        docEdits,
        outcome: claimedNoEdit ? 'claimed_no_edit' : (c.fullResponse ? 'completed' : 'abandoned'),
      })
    },
  },
  {
    name: 'follow-through',
    // #841 环⑤: 遵循度度量(零 LLM)— 激活的剧本卡按实际工具序列/产出物判定
    // 遵循与否,滑动窗口维护 followRate,达降级线自动 suspended(不删除)。
    run: async (c) => {
      if (c.skillCards.length === 0) return
      const { recordFollowThrough } = await import('../skills/follow-through.js')
      await recordFollowThrough({
        memory: c.ctx.memory,
        userId: c.userId,
        activated: c.skillCards,
        toolsUsed: c.timelineTools.map((t) => t.tool),
        docEdits: c.timelineTools.filter((t) => t.tool === 'edit_document').length,
        outcome: c.fullResponse ? 'completed' : 'abandoned',
      })
    },
  },
  {
    name: 'attachment-export-option',
    // #582 — 例 A: 通用会话编辑附件时给一条可落地出口。
    run: async (c) => {
      if (c.turnIntent.action !== 'edit' || c.turnIntent.target !== 'attachment') return
      c.send({
        type: 'attachment_export_option',
        options: ['save_as_document', 'export_pdf', 'continue_discussion'],
      })
    },
  },
  {
    name: 'evolution-enqueue',
    // #2: Extract takeaway + evolve facts + analyze patient chat (async evolution worker)
    // Writing sessions (doc-*) are excluded — their content must not
    // become global memory (leak into patient chats).
    run: async (c) => {
      if (!c.evolutionQueue || c.sessionId.startsWith('doc-')) return
      c.evolutionQueue.add({ userId: c.userId, sessionId: c.sessionId, userMessage: c.bodyText, patientHash: c.patientHash || undefined }).catch(() => {})
    },
  },
  {
    name: 'chat-analysis',
    // #6: analyze patient turns (attachments AND plain text) into both
    // free findings (patient profile) and structured record sections.
    // Fire-and-forget; rate-limited (every ~15s max per patient, or when
    // new files arrived).
    run: async (c) => {
      if (!c.patientHash || !(c.attachmentText || c.bodyText.length >= 6)) return
      const analysisText = c.attachmentText
        ? `[FILE CONTENT]\n${c.attachmentText}\n[CHAT]\nUser: ${c.bodyText}\nAI: ${c.fullResponse}`
        : `[CHAT]\nUser: ${c.bodyText}\nAI: ${c.fullResponse}`
      const lastRun = chatAnalysisThrottle.get(`${c.userId}:${c.patientHash}`) ?? 0
      const now = Date.now()
      if (now - lastRun < 15000) return
      chatAnalysisThrottle.set(`${c.userId}:${c.patientHash}`, now)
      if (chatAnalysisThrottle.size > 5000) chatAnalysisThrottle.clear()
      analyzeChatForMedicalRecord(c.userId, c.patientHash, analysisText, {
        userId: c.userId,
        workspaceId: c.userId,
        action: 'clinical.analysis',
      })
        .then(async ({ findings, sections }) => {
          if (findings.length > 0) {
            await updatePatientFromFindings(c.userId, c.patientHash!, findings)
          }
          if (Object.keys(sections).length > 0) {
            await updateMedicalRecordFromChat(c.userId, c.patientHash!, sections)
          }
        })
        .catch(() => {})
    },
  },
  {
    name: 'upsert-session',
    critical: true,
    // Update session (writing doc-* sessions never get a Session row;
    // legacy global-* default sessions must never be recreated).
    run: async (c) => {
      await upsertSessionRow(c.userId, c.sessionId, c.bodyText.slice(0, 50))
    },
  },
  {
    name: 'citations-sse',
    // #756: 注入透明化 — 本轮实际进入 system 的 kb 条目作为引用 chips。
    run: async (c) => {
      const seenCitation = new Set<string>()
      c.send({
        type: 'citations',
        items: c.kbCitations
          .filter((x) => !seenCitation.has(x.sourceId) && seenCitation.add(x.sourceId))
          .slice(0, 8)
          .map((x) => ({ text: x.label, source: `/app/knowledge?q=${encodeURIComponent(x.sourceId)}`, kind: x.kind })),
      })
    },
  },
  {
    name: 'skill-capture-suggest',
    // #298: suggest saving a reusable procedure as a skill.
    run: async (c) => {
      if (c.sessionId.startsWith('doc-')) return
      const { looksLikeProcedure } = await import('../skills/skill-capture.service.js')
      if (looksLikeProcedure(c.fullResponse)) {
        c.send({ type: 'skill_capture_suggest', text: '这个流程我帮你整理成了技能，下次可以直接调用。要保存吗？' })
      }
    },
  },
]

/** 按序执行后处理段: best-effort 段失败互不阻断,段级耗时 telemetry。 */
export async function runPostTurnPipeline(c: PostTurnContext): Promise<void> {
  for (const seg of POST_TURN_SEGMENTS) {
    const t0 = Date.now()
    try {
      await seg.run(c)
      log.info(`[post-turn] ${seg.name} ${Date.now() - t0}ms`)
    } catch (err) {
      if (seg.critical) throw err
      log.warn(`[post-turn] ${seg.name} failed (best-effort): ${(err as Error).message.slice(0, 160)}`)
    }
  }
}
