/**
 * #1106 — 回合时间线/图表收集器（自 conversation-turn.ts 提取）。
 *
 * runConversationTurn 曾内联一个 ~75 行的 io.send 包装：一边透传 SSE，
 * 一边按 chunk 类型投影收集三类持久化材料 —
 *   - chartMeta：chart_created 的 URL（随 assistant_response metadata 落库,
 *     历史重载恢复聊天里的图表 #723）
 *   - timelineTools/timelineSubs：tool_call/tool_result/subagent_* 折叠成
 *     有界 timeline 快照（前端刷新后重建工具芯片/子代理结果卡 #832-缺3）
 *   - turnDocSections：doc_updated.changed_sections（写回单点派生的实际
 *     变更节 — 聊天改动日志数据源 #996/#1003）
 *
 * 收集策略与透传顺序保持原实现：先收集，后 io.send(chunk)。失败的
 * 工具调用不产生 doc_updated，因此不会假称「改了这节」。
 */
import type { ChatStreamChunk } from '@heurion/contracts'
import type { TurnIO } from './tool-loop.js'

export interface TimelineToolEntry {
  tool: string
  seq: number
  round?: number
  argsPreview: string
  /** #1025: 循环身份（main/rescue）— 刷新后前端仍能按尝试分组。 */
  loop?: 'main' | 'rescue'
  status: 'running' | 'completed' | 'error'
  resultPreview?: string
  elapsedMs?: number
}

export interface TimelineSubEntry {
  id: string
  task: string
  status: 'running' | 'done' | 'failed'
  summaryPreview?: string
  turns?: number
  costTokens?: number
}

const MAX_TIMELINE_TOOLS = 40
const MAX_TIMELINE_SUBS = 12

export class TurnTimelineCollector {
  readonly chartMeta: Array<{ url: string; chartType?: string }> = []
  readonly timelineTools: TimelineToolEntry[] = []
  readonly timelineSubs: TimelineSubEntry[] = []
  /** #996/#1003: 本轮文档写回的节集合（改动日志持久化数据源）。 */
  readonly turnDocSections = new Map<string, string>()

  /** 单个 chunk 的投影收集（不透传 — 测试可单独驱动）。 */
  collect(chunk: ChatStreamChunk): void {
    // #790: TurnIO 已类型化 — 直接窄化，不再手工嗅探。
    if (chunk.type === 'chart_created') {
      this.chartMeta.push({ url: chunk.url, chartType: chunk.chart_type })
    } else if (chunk.type === 'tool_call' && chunk.seq !== undefined) {
      if (this.timelineTools.length < MAX_TIMELINE_TOOLS) {
        this.timelineTools.push({
          tool: chunk.tool,
          seq: chunk.seq,
          ...(chunk.round !== undefined ? { round: chunk.round } : {}),
          ...(chunk.loop !== undefined ? { loop: chunk.loop } : {}),
          argsPreview: String(JSON.stringify(chunk.args) || '').slice(0, 120),
          status: 'running',
        })
      }
    } else if (chunk.type === 'tool_result' && chunk.seq !== undefined) {
      const entry = this.timelineTools.find((t) => t.seq === chunk.seq)
      if (entry) {
        entry.status = chunk.success ? 'completed' : 'error'
        if (chunk.preview) entry.resultPreview = chunk.preview.slice(0, 80)
        if (chunk.elapsed_ms !== undefined) entry.elapsedMs = chunk.elapsed_ms
      }
    } else if (chunk.type === 'doc_updated') {
      // #996/#1003: 实际变更节（写回单点按新旧投影 hash diff 派生）回填
      // 标题；这是唯一记录点，target_section 预记已移除（失败调用曾残留）。
      for (const s of chunk.changed_sections ?? []) {
        if (s.id) this.turnDocSections.set(s.id, s.heading || this.turnDocSections.get(s.id) || '')
      }
    } else if (chunk.type === 'subagent_started') {
      if (this.timelineSubs.length < MAX_TIMELINE_SUBS) {
        this.timelineSubs.push({ id: chunk.id, task: chunk.task.slice(0, 200), status: 'running' })
      }
    } else if (chunk.type === 'subagent_done') {
      const entry = this.timelineSubs.find((s) => s.id === chunk.id)
      if (entry) {
        entry.status = chunk.success ? 'done' : 'failed'
        if (chunk.summary_preview) entry.summaryPreview = chunk.summary_preview.slice(0, 200)
        if (chunk.turns !== undefined) entry.turns = chunk.turns
        if (chunk.cost_tokens !== undefined) entry.costTokens = chunk.cost_tokens
      } else if (this.timelineSubs.length < MAX_TIMELINE_SUBS) {
        this.timelineSubs.push({
          id: chunk.id,
          task: chunk.task.slice(0, 200),
          status: chunk.success ? 'done' : 'failed',
          ...(chunk.summary_preview ? { summaryPreview: chunk.summary_preview.slice(0, 200) } : {}),
          ...(chunk.turns !== undefined ? { turns: chunk.turns } : {}),
          ...(chunk.cost_tokens !== undefined ? { costTokens: chunk.cost_tokens } : {}),
        })
      }
    }
  }

  /**
   * 包装 TurnIO：收集后透传原始 chunk（与原 ioWithChart 逐字同序）。
   * main 循环与 doc-executor rescue 必须共用同一个包装实例。
   */
  wrap(io: TurnIO): TurnIO {
    return {
      ...io,
      send: (chunk) => {
        this.collect(chunk)
        io.send(chunk)
      },
    }
  }
}
